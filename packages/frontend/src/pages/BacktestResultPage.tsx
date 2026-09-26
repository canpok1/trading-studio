import type {
	BacktestChart,
	BacktestRun,
	StoredStrategy,
} from "@trading-studio/backend";
import type { BacktestOrder } from "@trading-studio/core";
import {
	emaPeriods,
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
import {
	buyOrderText,
	conditionDiff,
	frequencyText,
	groupText,
	ruleText,
	stepLimitedText,
} from "../lib/condition-text";
import { formatInt, formatSignedInt, formatSignedPercent } from "../lib/number";
import { errorMessage, readJson, useAsync } from "../lib/useAsync";
import type { BacktestDraft } from "./BacktestRunPage";

const PAGE = 20;

type Data = {
	run: BacktestRun;
	chart: BacktestChart | null;
	saved: StoredStrategy | null;
};

export function BacktestResultPage() {
	const api = useApi();
	const { id = "" } = useParams();
	const job = useBacktestJob();

	const load = useCallback(async (): Promise<Data> => {
		const { run } = await api.api.backtests[":id"]
			.$get({ param: { id } })
			.then((r) => readJson<{ run: BacktestRun }>(r));
		const [chart, saved] = await Promise.all([
			run.status === "done"
				? api.api.backtests[":id"].chart
						.$get({ param: { id } })
						.then((r) => readJson<BacktestChart>(r))
				: null,
			run.strategyId !== null && run.strategyExists
				? api.api.strategies[":id"]
						.$get({ param: { id: String(run.strategyId) } })
						.then((r) => readJson<{ strategy: StoredStrategy }>(r))
						.then((r) => r.strategy)
						.catch(() => null)
				: null,
		]);
		return { run, chart, saved };
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
			<Page title={title}>
				<LoadingCard />
			</Page>
		);
	}
	if (state.kind === "error") {
		return (
			<Page title={title}>
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
	const { run, chart, saved } = state.data;
	return (
		<Page title={title} actions={<RerunButton run={run} />}>
			<RunHeader run={run} saved={saved} onSaved={reload} />
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
			{run.status === "done" && run.summary && chart && (
				<Result run={run} chart={chart} />
			)}
		</Page>
	);
}

function rerunState(run: BacktestRun): Partial<BacktestDraft> {
	return {
		params: run.params,
		fromDate: toDateInputValue(run.from),
		toDate: toDateInputValue(run.to - 1),
		initialCash: run.initialCash,
		fees: run.fees,
	};
}

function RerunButton({ run }: { run: BacktestRun }) {
	const navigate = useNavigate();
	return (
		<Button
			size="sm"
			onClick={() =>
				navigate(
					`/backtest${run.strategyExists && run.strategyId !== null ? `?strategy=${run.strategyId}` : ""}`,
					{ state: rerunState(run) },
				)
			}
		>
			条件を変えて再実行
		</Button>
	);
}

const pct = (ppm: number) => `${ppmToPercent(ppm)}%`;

function RunHeader({
	run,
	saved,
	onSaved,
}: {
	run: BacktestRun;
	saved: StoredStrategy | null;
	onSaved: () => void;
}) {
	const [saving, setSaving] = useState(false);
	const p = run.params;
	const same =
		saved !== null && JSON.stringify(saved.params) === JSON.stringify(p);
	const chips = [
		frequencyText(p),
		`買: ${groupText(p.buy)}`,
		`買いの注文: ${buyOrderText(p.buyOrder)}`,
		`利確: ${groupText(p.takeProfit)}`,
		`損切り: ${groupText(p.stopLoss)}`,
		`${formatBtc(p.orderSize)} BTC`,
		`手数料 指値${pct(run.fees.limitPpm)}/成行${pct(run.fees.marketPpm)}`,
		// チャートの判定もこのルールで出すので、判定の条件が無い戦略でも出す
		...(run.aggregationRule ? [ruleText(run.aggregationRule)] : []),
	];
	return (
		<div className="flex flex-col gap-1.5">
			<strong className="text-[15px]">
				{run.strategyName} · {TIMEFRAME_LABELS[run.timeframe]}
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
						className="num inline-flex h-6 items-center rounded-md bg-surface-2 px-2 text-[11px]"
					>
						{c}
					</li>
				))}
			</ul>
			{run.stepLimited && <Note>{stepLimitedText(run.stepTimeframe)}</Note>}
			{run.status === "done" && (
				<div className="mt-1">
					{same ? (
						<span className="text-xs text-text-2">
							「{saved.name}」の保存済みの条件と同じ
						</span>
					) : (
						<Button size="sm" onClick={() => setSaving(true)}>
							この条件を戦略に保存
						</Button>
					)}
				</div>
			)}
			{saving && (
				<SaveDialog
					run={run}
					saved={saved}
					onClose={() => setSaving(false)}
					onDone={() => {
						setSaving(false);
						onSaved();
					}}
				/>
			)}
		</div>
	);
}

function SaveDialog({
	run,
	saved,
	onClose,
	onDone,
}: {
	run: BacktestRun;
	saved: StoredStrategy | null;
	onClose: () => void;
	onDone: () => void;
}) {
	const api = useApi();
	const nameId = useId();
	const [name, setName] = useState(`${run.strategyName} のコピー`);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const save = async (body: { overwrite: true } | { name: string }) => {
		setBusy(true);
		try {
			await api.api.backtests[":id"].save
				.$post({ param: { id: String(run.id) }, json: body })
				.then((r) => readJson(r));
			onDone();
		} catch (e) {
			setError(errorMessage(e));
			setBusy(false);
		}
	};
	const diff = saved ? conditionDiff(saved.params, run.params) : [];
	return (
		<Modal title="この条件を戦略に保存する" onClose={onClose}>
			{saved && (
				<section className="flex flex-col gap-2">
					<strong className="text-sm">「{saved.name}」を上書き</strong>
					<dl className="flex flex-col gap-2 rounded-[10px] bg-bg p-3 text-xs">
						{diff.length === 0 && <span>変更なし</span>}
						{diff.map(([label, before, after]) => (
							<div key={label} className="flex flex-col gap-0.5">
								<dt className="text-text-2">{label}</dt>
								<dd className="num text-text-2">{before}</dd>
								<dd className="num font-semibold">→ {after}</dd>
							</div>
						))}
					</dl>
					<Button
						variant="primary"
						disabled={busy}
						onClick={() => save({ overwrite: true })}
					>
						上書きして保存
					</Button>
				</section>
			)}
			<section className="flex flex-col gap-2">
				<strong className="text-sm">新しい戦略として保存</strong>
				<label htmlFor={nameId} className="text-xs text-text-2">
					名前
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
				<Button disabled={busy} onClick={() => save({ name })}>
					新しい戦略として保存
				</Button>
			</section>
			<Button onClick={onClose}>やめる</Button>
		</Modal>
	);
}

function holdingText(ms: number): string {
	const h = ms / 3_600_000;
	return h >= 24 ? `${(h / 24).toFixed(1)}日` : `${h.toFixed(1)}時間`;
}

function Result({ run, chart }: { run: BacktestRun; chart: BacktestChart }) {
	const api = useApi();
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

	const emas = emaPeriods(run.params);
	const noOrders = run.orderCount === 0;
	const tone = (n: number) => (n >= 0 ? "text-profit" : "text-loss");

	return (
		<div className="flex flex-col gap-3.5 lg:grid lg:grid-cols-[360px_minmax(0,1fr)] lg:items-start">
			<section
				aria-label="成績の要約"
				className="flex flex-col gap-3.5 rounded-xl border border-line bg-surface px-4 py-3.5"
			>
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
					<span className="num text-xs text-text-2">
						同期間のガチホ（買って保有）
						{formatSignedPercent(s.buyAndHoldPercent)}
					</span>
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
			<div className="rounded-xl border border-line bg-surface px-3 py-3.5 lg:col-start-2 lg:row-span-2 lg:row-start-1">
				<PriceChart
					bars={chart.bars}
					markers={chart.markers}
					emaPeriods={emas}
					selectedId={selected?.id ?? null}
					onMarker={(m) => pick(m.id)}
					judgments={judgments}
					bg={bg}
					onBgChange={setBg}
				/>
			</div>
			<section aria-label="注文と約定" className="flex flex-col gap-2">
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
