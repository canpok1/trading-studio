import type { BacktestChart, BacktestRun } from "@trading-studio/backend";
import type { BacktestOrder, ConditionSet } from "@trading-studio/core";
import {
	conditionSetChanges,
	formatBtc,
	ppmToPercent,
	TIMEFRAME_LABELS,
} from "@trading-studio/core";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { useNavigate, useParams } from "react-router";
import { useApi } from "../api";
import { AdviceSection } from "../components/backtest/AdviceSection";
import { OrderRow, OrderSheet, Stat } from "../components/backtest/OrderViews";
import { alignJudgments } from "../components/chart/judgment-data";
import { PriceChart } from "../components/chart/PriceChart";
import { Modal } from "../components/Modal";
import { Page } from "../components/Page";
import { EmptyState, ErrorState, LoadingCard } from "../components/States";
import { Button, Card, Note, ProgressBar, Segmented } from "../components/ui";
import { formatDate, toDateInputValue } from "../format";
import { useBacktestJob } from "../lib/backtest-job";
import { useChartBg } from "../lib/chart-bg";
import { useChartIndicators } from "../lib/chart-indicators";
import {
	buyOrderText,
	frequencyText,
	groupText,
	ruleText,
	stepLimitedText,
} from "../lib/condition-text";
import {
	formatInt,
	formatSignedInt,
	formatSignedPercent,
	holdingText,
} from "../lib/number";
import { errorMessage, readJson, useAsync } from "../lib/useAsync";
import type { BacktestDraft } from "./BacktestRunPage";
import { BACKTEST_NAME_MAX } from "./BacktestRunPage";

const PAGE = 20;

type Data = {
	run: BacktestRun;
	chart: BacktestChart | null;
};

/** 「履歴」のタブへ戻る */
const BACK = { to: "/backtest?tab=history", label: "履歴" };

export function BacktestResultPage() {
	const api = useApi();
	const { id = "" } = useParams();
	const job = useBacktestJob();

	const load = useCallback(async (): Promise<Data> => {
		const { run } = await api.api.backtests[":id"]
			.$get({ param: { id } })
			.then((r) => readJson<{ run: BacktestRun }>(r));
		const chart =
			run.status === "done"
				? await api.api.backtests[":id"].chart
						.$get({ param: { id } })
						.then((r) => readJson<BacktestChart>(r))
				: null;
		return { run, chart };
	}, [api, id]);
	const { state, reload } = useAsync(load);

	// この実行が終わったら読み直す
	const runningHere = job.running?.id === Number(id);
	const wasRunning = useRef(runningHere);
	useEffect(() => {
		if (wasRunning.current && !runningHere) reload();
		wasRunning.current = runningHere;
	}, [runningHere, reload]);

	const title = "バックテスト結果";
	if (state.kind === "loading") {
		return (
			<Page title={title} back={BACK}>
				<LoadingCard />
			</Page>
		);
	}
	if (state.kind === "error") {
		return (
			<Page title={title} back={BACK}>
				<Card>
					<ErrorState
						what={`結果を読み込めなかった（${state.message}）`}
						next="サーバーが動いているか確かめてから、もう一度読み込む"
						action={<Button onClick={reload}>もう一度読み込む</Button>}
					/>
				</Card>
			</Page>
		);
	}
	const { run, chart } = state.data;
	const done = run.status === "done" && run.summary !== null && chart !== null;
	return (
		<Page title={title} back={BACK} actions={<RerunButton run={run} />}>
			{/* 結果があれば、条件は成績と並べて結果の中に出す */}
			{!done && <RunHeader run={run} />}
			{run.status === "running" && (
				<Card className="flex flex-col gap-2.5">
					<strong>バックテストを実行中</strong>
					<ProgressBar
						value={
							(runningHere ? (job.running?.progress ?? 0) : run.progress) * 100
						}
						label="バックテストの進み具合"
					/>
				</Card>
			)}
			{(run.status === "failed" || run.status === "canceled") && (
				<Card>
					<ErrorState
						what={
							run.status === "canceled"
								? "この実行は中止した"
								: `この実行は失敗した（${run.error ?? "原因不明"}）`
						}
						next="条件を見直して、もう一度実行する"
						action={<RerunButton run={run} />}
					/>
				</Card>
			)}
			{done && chart && <Result run={run} chart={chart} />}
		</Page>
	);
}

function rerunState(run: BacktestRun): Partial<BacktestDraft> {
	return {
		name: run.name,
		template: null,
		params: run.params,
		fromDate: toDateInputValue(run.from),
		toDate: toDateInputValue(run.to - 1),
		initialCash: run.initialCash,
		fees: run.fees,
	};
}

/**
 * 改善版でバックテストするときの下書き。期間・口座は元のまま、名前に「（改善版）」を付ける。
 * 改善版をさらに改善したときに重ねないよう、元の名前の末尾の「（改善版）」は外す
 */
function improvedState(
	run: BacktestRun,
	params: ConditionSet,
): Partial<BacktestDraft> {
	const suffix = "（改善版）";
	const base = run.name.endsWith(suffix)
		? run.name.slice(0, -suffix.length)
		: run.name;
	return {
		...rerunState(run),
		name: base.slice(0, BACKTEST_NAME_MAX - suffix.length) + suffix,
		params,
		improvement: { changes: conditionSetChanges(run.params, params) },
	};
}

function RerunButton({ run }: { run: BacktestRun }) {
	const navigate = useNavigate();
	return (
		<Button
			size="sm"
			onClick={() => navigate("/backtest", { state: rerunState(run) })}
		>
			条件を変えて再実行
		</Button>
	);
}

const pct = (ppm: number) => `${ppmToPercent(ppm)}%`;

function RunHeader({ run }: { run: BacktestRun }) {
	const [saving, setSaving] = useState(false);
	const [savedAs, setSavedAs] = useState<string | null>(null);
	const p = run.params;
	const chips = [
		frequencyText(p),
		`買: ${groupText(p.buy)}`,
		`買いの注文: ${buyOrderText(p.buyOrder)}`,
		`利確: ${groupText(p.takeProfit)}`,
		`損切り: ${groupText(p.stopLoss)}`,
		`${formatBtc(p.orderSize)} BTC`,
		`最大ポジション数 ${p.maxPositions}`,
		...(run.dailyLossLimitApplied
			? [`1日の損失上限 ${formatInt(p.dailyLossLimit)}円`]
			: []),
		`手数料 指値${pct(run.fees.limitPpm)}/成行${pct(run.fees.marketPpm)}`,
		// チャートの判定もこのルールで出すので、判定の条件が無い戦略でも出す
		...(run.aggregationRule ? [ruleText(run.aggregationRule)] : []),
	];
	return (
		<section
			aria-label="実行の条件"
			className="flex flex-col gap-1.5 rounded-xl border border-line bg-surface px-4 py-3.5"
		>
			<strong className="text-[15px]">
				{run.name} · {TIMEFRAME_LABELS[run.timeframe]}
			</strong>
			<span className="num text-xs text-text-2">
				{formatDate(run.from)}〜{formatDate(run.to - 1)} · 初期資金{" "}
				{formatInt(run.initialCash)}円
				{run.skipGaps ? " · 欠損を飛ばして実行" : ""}
				{run.stepTimeframe !== run.timeframe
					? ` · ${TIMEFRAME_LABELS[run.stepTimeframe]}で判定`
					: ""}
			</span>
			<ul aria-label="実行条件" className="flex flex-wrap gap-1.5">
				{chips.map((c) => (
					<li
						key={c}
						className="num inline-flex min-h-6 items-center rounded-md bg-surface-2 px-2 py-0.5 text-[11px]"
					>
						{c}
					</li>
				))}
			</ul>
			{run.stepLimited && <Note>{stepLimitedText(run.stepTimeframe)}</Note>}
			{run.status === "done" && (
				<div className="mt-1">
					{savedAs ? (
						<span role="status" className="text-xs text-text-2">
							「{savedAs}」として戦略に保存した
						</span>
					) : (
						<Button size="sm" onClick={() => setSaving(true)}>
							新しい戦略として保存
						</Button>
					)}
				</div>
			)}
			{saving && (
				<SaveDialog
					run={run}
					onClose={() => setSaving(false)}
					onDone={(name) => {
						setSaving(false);
						setSavedAs(name);
					}}
				/>
			)}
		</section>
	);
}

function SaveDialog({
	run,
	onClose,
	onDone,
}: {
	run: BacktestRun;
	onClose: () => void;
	onDone: (name: string) => void;
}) {
	const api = useApi();
	const nameId = useId();
	const [name, setName] = useState(run.name);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const save = async () => {
		setBusy(true);
		try {
			const r = await api.api.backtests[":id"].save
				.$post({ param: { id: String(run.id) }, json: { name } })
				.then((r) => readJson<{ strategy: { name: string } }>(r));
			onDone(r.strategy.name);
		} catch (e) {
			setError(errorMessage(e));
			setBusy(false);
		}
	};
	return (
		<Modal title="新しい戦略として保存する" onClose={onClose}>
			<div className="flex flex-col gap-2">
				<label htmlFor={nameId} className="text-xs text-text-2">
					戦略の名前
				</label>
				<input
					id={nameId}
					value={name}
					onChange={(e) => {
						setName(e.target.value);
						setError(null);
					}}
					aria-invalid={error ? true : undefined}
					className="h-12 rounded-[10px] border border-line bg-surface px-3 text-[15px] aria-invalid:border-2 aria-invalid:border-loss"
				/>
				{error && (
					<span className="text-xs font-semibold text-loss">{error}</span>
				)}
			</div>
			<Button variant="primary" disabled={busy} onClick={save}>
				保存
			</Button>
			<Button onClick={onClose}>やめる</Button>
		</Modal>
	);
}

function Result({ run, chart }: { run: BacktestRun; chart: BacktestChart }) {
	const api = useApi();
	const navigate = useNavigate();
	const s = run.summary as NonNullable<BacktestRun["summary"]>;
	const [filter, setFilter] = useState<"filled" | "all">("filled");
	const [orders, setOrders] = useState<BacktestOrder[]>([]);
	const [total, setTotal] = useState(0);
	const [listError, setListError] = useState<string | null>(null);
	const [selected, setSelected] = useState<BacktestOrder | null>(null);
	const [bg, setBg] = useChartBg();
	const judgments = useMemo(
		() =>
			chart.judgments
				? alignJudgments(
						chart.judgments,
						chart.bars.map((b) => b.time),
					)
				: null,
		[chart],
	);

	const loadPage = useCallback(
		async (offset: number) => {
			try {
				const r = await api.api.backtests[":id"].orders
					.$get({
						param: { id: String(run.id) },
						query: { filter, offset: String(offset), limit: String(PAGE) },
					})
					.then((res) =>
						readJson<{ orders: BacktestOrder[]; total: number }>(res),
					);
				setOrders((cur) => (offset === 0 ? r.orders : [...cur, ...r.orders]));
				setTotal(r.total);
				setListError(null);
			} catch (e) {
				setListError(errorMessage(e));
			}
		},
		[api, run.id, filter],
	);
	useEffect(() => {
		loadPage(0);
	}, [loadPage]);

	const pick = async (orderId: string) => {
		try {
			const r = await api.api.backtests[":id"].orders[":orderId"]
				.$get({ param: { id: String(run.id), orderId } })
				.then((res) => readJson<{ order: BacktestOrder }>(res));
			setSelected(r.order);
		} catch (e) {
			setListError(errorMessage(e));
		}
	};

	const indicators = useChartIndicators(run.params);
	const noOrders = run.orderCount === 0;
	const tone = (n: number) => (n >= 0 ? "text-profit" : "text-loss");

	return (
		// 広い画面は上段に条件と成績を並べ、チャート以下は2列幅で縦に積む
		<div className="flex flex-col gap-3.5 lg:grid lg:grid-cols-2">
			<RunHeader run={run} />
			<section
				aria-label="成績の要約"
				className="flex flex-col gap-3.5 rounded-xl border border-line bg-surface px-4 py-3.5"
			>
				<h2 className="text-[15px] font-bold">成績</h2>
				<div className="flex flex-col gap-0.5">
					<span className="text-xs text-text-2">損益</span>
					<div className="flex items-baseline gap-2.5">
						<span
							className={`num text-[30px] font-semibold tracking-tight ${tone(s.pnl)}`}
						>
							{formatSignedInt(s.pnl)}円
						</span>
						<span className={`num text-base font-semibold ${tone(s.pnl)}`}>
							{formatSignedPercent(s.pnlPercent)}
						</span>
					</div>
				</div>
				<div className="grid grid-cols-3 gap-x-2 gap-y-3 border-t border-line pt-3">
					<Stat
						label="勝率"
						value={s.winRate !== null ? `${s.winRate.toFixed(1)}%` : "—"}
						sub={`${s.wins}勝 ${s.losses}敗`}
					/>
					<Stat
						label="最大DD"
						value={
							s.maxDrawdownPercent > 0
								? `−${s.maxDrawdownPercent.toFixed(1)}%`
								: "0.0%"
						}
						tone="text-loss"
						sub={
							s.maxDrawdownFrom !== null && s.maxDrawdownTo !== null
								? `${formatDate(s.maxDrawdownFrom).slice(5)}〜${formatDate(s.maxDrawdownTo).slice(5)}`
								: undefined
						}
					/>
					<Stat
						label="損益比率（PF）"
						value={
							s.trades === 0
								? "—"
								: s.profitFactor === null
									? "∞"
									: s.profitFactor.toFixed(2)
						}
					/>
					<Stat label="取引回数" value={String(s.trades)} sub="往復" />
					<Stat
						label="平均保有"
						value={
							s.averageHoldingMs !== null
								? holdingText(s.averageHoldingMs)
								: "—"
						}
					/>
					<Stat label="最終資金" value={formatInt(s.finalEquity)} />
				</div>
				{s.openPositionQuantity > 0 && (
					<p className="text-xs text-text-2">
						期間の終わりに {formatBtc(s.openPositionQuantity)} BTC
						を保有していた。損益・最終資金は最後の終値で評価し、取引回数・勝率には含めない。
					</p>
				)}
			</section>
			<div className="rounded-xl border border-line bg-surface px-3 py-3.5 lg:col-span-2">
				<PriceChart
					bars={chart.bars}
					markers={chart.markers}
					indicators={indicators}
					selectedId={selected?.id ?? null}
					onMarker={(m) => pick(m.id)}
					judgments={judgments}
					bg={bg}
					onBgChange={setBg}
				/>
			</div>
			<div className="lg:col-span-2">
				<AdviceSection
					runId={run.id}
					onImprove={(params) =>
						navigate("/backtest", { state: improvedState(run, params) })
					}
				/>
			</div>
			<section
				aria-label="注文と約定"
				className="flex flex-col gap-2 lg:col-span-2"
			>
				{noOrders ? (
					<Card>
						<EmptyState
							title="注文が 1 件も出なかった"
							description="この条件では買いの条件を満たさなかった。条件や期間を見直す。"
							action={<RerunButton run={run} />}
						/>
					</Card>
				) : (
					<>
						<div className="flex items-center justify-between gap-2">
							<h2 className="text-[15px] font-bold">注文・約定</h2>
							<Segmented
								name="order-filter"
								label="一覧に出す注文"
								size="sm"
								options={[
									["filled", `約定 ${run.filledCount}`],
									["all", `注文 ${run.orderCount}`],
								]}
								value={filter}
								onChange={setFilter}
							/>
						</div>
						<div className="overflow-hidden rounded-xl border border-line">
							{orders.map((o) => (
								<OrderRow
									key={o.id}
									order={o}
									selected={selected?.id === o.id}
									onClick={() => setSelected(o)}
								/>
							))}
							{orders.length === 0 && (
								<p className="bg-surface px-4 py-3 text-xs text-text-2">なし</p>
							)}
						</div>
						{listError && (
							<p role="alert" className="text-xs font-semibold text-loss">
								{listError}
							</p>
						)}
						{orders.length < total && (
							<Button onClick={() => loadPage(orders.length)}>
								さらに表示（残り {total - orders.length} 件）
							</Button>
						)}
					</>
				)}
			</section>
			{selected && (
				<OrderSheet
					order={selected}
					onClose={() => setSelected(null)}
					onPair={(oid) => pick(oid)}
				/>
			)}
		</div>
	);
}
