import type {
	AutoTradingStatus,
	CurrentJudgment,
	JudgmentSeries,
	LatestMarket,
	StoredOrder,
	StoredStrategy,
	TimeframeCoverage,
} from "@trading-studio/backend";
import type { Timeframe } from "@trading-studio/core";
import {
	JUDGE_LABELS,
	JUDGES,
	TIMEFRAME_LABELS,
	TIMEFRAME_MS,
	TIMEFRAMES,
} from "@trading-studio/core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useApi } from "../api";
import { orderTime } from "../components/backtest/OrderViews";
import type { ChartBar, ChartMarker } from "../components/chart/chart-data";
import { alignJudgments } from "../components/chart/judgment-data";
import { PriceChart } from "../components/chart/PriceChart";
import { AccountPanel } from "../components/home/AccountPanel";
import { AutoTradingCard } from "../components/home/AutoTradingCard";
import { OrdersPanel } from "../components/home/OrdersPanel";
import { PANEL, PanelHeader } from "../components/home/Panel";
import { PerformancePanel } from "../components/home/PerformancePanel";
import { AddRunDialog } from "../components/home/RunDialogs";
import { JudgmentBadge } from "../components/judgment/JudgmentBadge";
import { EmptyState, ErrorState, Skeleton } from "../components/States";
import {
	LIVE_AVAILABLE,
	ModeTag,
	TradeOrderSheet,
} from "../components/trading/TradeViews";
import { Button } from "../components/ui";
import { useChartBg } from "../lib/chart-bg";
import { useChartIndicators } from "../lib/chart-indicators";
import { initialSpanMs, useChartTimeframe } from "../lib/chart-timeframe";
import {
	changePercent,
	collectorTrouble,
	judgmentsFrom,
	loadRange,
	withLatestPrice,
} from "../lib/home";
import { formatSignedPercent } from "../lib/number";
import {
	MAX_RUNS,
	useTradingOrders,
	useTradingPerformance,
	useTradingStatus,
} from "../lib/trading";
import {
	errorMessage,
	readJson,
	useAsync,
	useInterval,
	usePageVisible,
} from "../lib/useAsync";

/** 最新価格を問い合わせる間隔 */
const LATEST_MS = 5_000;
/** チャートの足を取り直す間隔。その間は最新の価格を最後の足に反映する */
const BARS_MS = 60_000;
/** EMA・RSI の計算のために期間の前に足す本数（最も長い本数の何倍か） */
const EMA_HISTORY_FACTOR = 3;
const MAX_HISTORY = 1_000;
/** チャートの印に読む注文の数 */
const MARKER_ORDERS = 300;

export function HomePage() {
	const api = useApi();
	const visible = usePageVisible();

	// 最新価格
	const [latest, setLatest] = useState<LatestMarket | null>(null);
	const [latestError, setLatestError] = useState<string | null>(null);
	const loadLatest = useCallback(async () => {
		try {
			const r = await api.api.market.latest
				.$get()
				.then((res) => readJson<LatestMarket>(res));
			setLatest(r);
			setLatestError(null);
		} catch (e) {
			setLatestError(errorMessage(e));
		}
	}, [api]);
	useEffect(() => {
		if (visible) loadLatest();
	}, [visible, loadLatest]);
	useInterval(loadLatest, LATEST_MS, visible);

	// 戦略と、全期間の足の数（選べる粒度の判定に使う）
	const loadSetup = useCallback(async () => {
		const [list, coverage] = await Promise.all([
			api.api.strategies
				.$get()
				.then((r) => readJson<{ strategies: StoredStrategy[] }>(r)),
			api.api.data.coverage
				.$get()
				.then((r) => readJson<{ timeframes: TimeframeCoverage[] }>(r)),
		]);
		const counts: Partial<Record<Timeframe, number>> = {};
		for (const c of coverage.timeframes) counts[c.timeframe] = c.count;
		return { strategies: list.strategies, counts };
	}, [api]);
	const setup = useAsync(loadSetup);

	if (setup.state.kind === "error") {
		return (
			<HomeFrame>
				<ErrorState
					what="ホームのデータを読み込めなかった"
					next={setup.state.message}
					action={<Button onClick={setup.reload}>もう一度読み込む</Button>}
				/>
			</HomeFrame>
		);
	}
	if (setup.state.kind === "loading") {
		return (
			<HomeFrame>
				<div
					role="status"
					aria-label="読み込み中"
					className="flex flex-col gap-3"
				>
					<Skeleton className="h-4 w-1/2" />
					<Skeleton className="h-9 w-2/3" />
					<Skeleton className="h-[320px] w-full" />
				</div>
			</HomeFrame>
		);
	}
	return (
		<HomeBody
			latest={latest}
			latestError={latestError}
			onRetryLatest={loadLatest}
			strategies={setup.state.data.strategies}
			counts={setup.state.data.counts}
			visible={visible}
		/>
	);
}

function HomeFrame({ children }: { children: ReactNode }) {
	return (
		<div className="mx-auto flex max-w-[720px] flex-col gap-3.5 px-4 pt-4 pb-2 lg:grid lg:max-w-none lg:grid-cols-2 lg:items-stretch lg:gap-4 lg:px-6">
			<h1 className="sr-only">ホーム</h1>
			{children}
		</div>
	);
}

function HomeBody({
	latest,
	latestError,
	onRetryLatest,
	strategies,
	counts,
	visible,
}: {
	latest: LatestMarket | null;
	latestError: string | null;
	onRetryLatest: () => void;
	strategies: StoredStrategy[];
	counts: Partial<Record<Timeframe, number>>;
	visible: boolean;
}) {
	const api = useApi();
	const { runs, set } = useTradingStatus();
	// タブはクエリの run で持つ。無ければ稼働中の最初のタブ、どれも止まっていれば先頭。
	// 以前の ?mode= のリンクは、そのモードの最初のタブで開く
	const [params, setParams] = useSearchParams();
	const runParam = Number(params.get("run"));
	const modeParam = params.get("mode");
	const run =
		runs?.find((r) => r.id === runParam) ??
		runs?.find((r) => r.mode === modeParam) ??
		runs?.find((r) => r.enabled) ??
		runs?.[0] ??
		null;
	const runId = run?.id ?? 0;
	const [adding, setAdding] = useState(false);
	// ライブが使えない間、ライブのタブは口座・成績・注文を出さない
	const hasAccount = run !== null && !(run.mode === "live" && !LIVE_AVAILABLE);
	const account = run?.account ?? null;
	// 状態は定期的に取り直すので、買値が変わったときだけ線を引き直す
	const entryKey = account?.lots.map((l) => l.entryPrice).join(",") ?? "";
	const entryPrices = useMemo(
		() => (entryKey ? entryKey.split(",").map(Number) : []),
		[entryKey],
	);
	const { orders, reload: reloadOrders } = useTradingOrders(
		{ runId, limit: MARKER_ORDERS },
		visible && hasAccount,
	);
	const perf = useTradingPerformance(runId, visible && hasAccount);
	const [selectedOrder, setSelectedOrder] = useState<string | null>(null);
	const [toast, setToast] = useState<string | null>(null);
	const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const showToast = useCallback((message: string) => {
		setToast(message);
		if (toastTimer.current) clearTimeout(toastTimer.current);
		toastTimer.current = setTimeout(() => setToast(null), 2_600);
	}, []);
	useEffect(
		() => () => {
			if (toastTimer.current) clearTimeout(toastTimer.current);
		},
		[],
	);
	const active = strategies.find((x) => x.id === run?.strategy?.id) ?? null;

	const [timeframe, setTimeframe] = useChartTimeframe();
	const range = loadRange(timeframe, counts);

	// EMA・RSI の本数は、選んでいる粒度の足で数える
	const indicators = useChartIndicators(active?.params ?? null);
	// 表示の切り替えで読み直さないよう、隠している指標の分も読む
	const history = Math.min(
		MAX_HISTORY,
		Math.max(...indicators.ema.value, indicators.rsi.value.period) *
			EMA_HISTORY_FACTOR,
	);

	const [bars, setBars] = useState<{
		key: string;
		bars: ChartBar[];
	} | null>(null);
	const [barsError, setBarsError] = useState<string | null>(null);
	// 判定は足と一緒に取り直す。読めなくても価格のチャートは出す
	const [current, setCurrent] = useState<CurrentJudgment | null>(null);
	// どの足の条件で取った判定かを持ち、切り替え直後に別の粒度の判定を当てはめない
	const [series, setSeries] = useState<{
		key: string;
		series: JudgmentSeries;
	} | null>(null);
	const [bg, setBg] = useChartBg();
	const barsKey = `${timeframe}:${range}:${history}`;
	const barsSeq = useRef(0);
	const loadBars = useCallback(async () => {
		const my = ++barsSeq.current;
		try {
			const r = await api.api.market.bars
				.$get({
					query: { timeframe, range, history: String(history) },
				})
				.then((res) => readJson<{ bars: ChartBar[] }>(res));
			if (my === barsSeq.current) {
				setBars({ key: barsKey, bars: r.bars });
				setBarsError(null);
			}
			// 判定は読めなくても価格のチャートは出すので、失敗は表示を前のまま残すだけにする
			api.api.judgments.current
				.$get()
				.then((res) => readJson<CurrentJudgment>(res))
				.then((c) => {
					if (my === barsSeq.current) setCurrent(c);
				})
				.catch(() => {});
			const first = r.bars[0];
			const last = r.bars.at(-1);
			if (first && last) {
				api.api.judgments.series
					.$get({
						query: {
							from: String(judgmentsFrom(first.time, last.time, timeframe)),
							// 最新の価格から作る今の足にも判定を付けるため、今の時刻まで含める
							to: String(
								Math.max(last.time, Date.now()) + TIMEFRAME_MS[timeframe],
							),
							timeframe,
						},
					})
					.then((res) => readJson<JudgmentSeries>(res))
					.then((sr) => {
						if (my === barsSeq.current) setSeries({ key: barsKey, series: sr });
					})
					.catch(() => {});
			}
		} catch (e) {
			if (my === barsSeq.current) setBarsError(errorMessage(e));
		}
	}, [api, timeframe, range, history, barsKey]);
	useEffect(() => {
		if (visible) loadBars();
	}, [visible, loadBars]);
	useInterval(loadBars, BARS_MS, visible);

	// 粒度を切り替えた直後は前の条件の足が残っている。届くまでは最新の価格も EMA も重ねない
	const fresh = bars?.key === barsKey;
	const shownBars = useMemo(() => {
		if (!bars) return [];
		if (!fresh) return bars.bars;
		return withLatestPrice(
			bars.bars,
			timeframe,
			latest?.price ?? null,
			latest?.priceTime ?? null,
		);
	}, [bars, fresh, timeframe, latest]);

	const selectRun = (id: number) => {
		setSelectedOrder(null);
		setParams({ run: String(id) }, { replace: true });
	};

	const barJudgments = useMemo(
		() =>
			fresh && series?.key === barsKey
				? alignJudgments(
						series.series,
						shownBars.map((b) => b.time),
					)
				: null,
		[fresh, series, barsKey, shownBars],
	);

	const markers = useMemo(
		() =>
			hasAccount
				? toMarkers(orders ?? [], shownBars, latest?.price ?? null)
				: [],
		[hasAccount, orders, shownBars, latest],
	);

	const noData =
		latest !== null && latest.price === null && bars?.bars.length === 0;

	return (
		<HomeFrame>
			<RunTabs
				runs={runs}
				current={run?.id ?? null}
				onSelect={selectRun}
				onAdd={() => setAdding(true)}
			/>
			<CollectorAlert latest={latest} />
			{latestError && (
				<div
					role="alert"
					className="flex items-center gap-3 rounded-[10px] bg-warn px-3.5 py-3 text-xs lg:col-span-2"
				>
					<span className="flex-1">
						最新の価格を読み込めなかった（{latestError}
						）。5秒ごとに読み直している
					</span>
					<Button size="sm" onClick={onRetryLatest}>
						今すぐ読み直す
					</Button>
				</div>
			)}
			{run ? (
				<AutoTradingCard
					key={`card-${run.id}`}
					run={run}
					strategies={strategies}
					canDelete={(runs?.length ?? 0) > 1}
					onToast={showToast}
					onDeleted={() => {
						setSelectedOrder(null);
						setParams({}, { replace: true });
					}}
				/>
			) : (
				<Skeleton className="h-32 rounded-xl" />
			)}
			{!hasAccount ? null : run ? (
				<AccountPanel
					key={`account-${run.id}`}
					status={run}
					performance={perf.performance}
					price={latest?.price ?? null}
					onToast={showToast}
					onReset={() => {
						perf.reload();
						reloadOrders();
					}}
				/>
			) : (
				<Skeleton className="h-32 rounded-xl" />
			)}
			{hasAccount && (
				<PerformancePanel performance={perf.performance} error={perf.error} />
			)}
			<JudgmentPanel current={current} />
			{barsError && !bars ? (
				<section aria-label="価格チャート" className={`${PANEL} lg:col-span-2`}>
					<PanelHeader title="チャート" />
					<ErrorState
						what="チャートの足を読み込めなかった"
						next={barsError}
						action={<Button onClick={loadBars}>もう一度読み込む</Button>}
					/>
				</section>
			) : noData ? (
				<section aria-label="価格チャート" className={`${PANEL} lg:col-span-2`}>
					<PanelHeader title="チャート" />
					<EmptyState
						title="収集を始めたばかりでデータが無い"
						description="価格を受け取ると、ここにチャートが出る"
					/>
				</section>
			) : (
				<PriceChart
					bars={shownBars}
					indicators={indicators}
					hideIndicators={!fresh}
					initialSpanMs={initialSpanMs(timeframe)}
					viewKey={bars?.key ?? ""}
					currentPrice={latest?.price ?? null}
					entryPrices={entryPrices}
					judgments={barJudgments}
					markers={markers}
					selectedId={selectedOrder}
					onMarker={(m) => setSelectedOrder(m.id)}
					bg={bg}
					onBgChange={setBg}
					compact
					latestNote={<Change24h latest={latest} />}
					toolbar={
						<select
							aria-label="足の粒度"
							value={timeframe}
							onChange={(e) => setTimeframe(e.target.value as Timeframe)}
							className="h-8 rounded-lg border border-line bg-surface px-2.5 text-xs font-semibold"
						>
							{TIMEFRAMES.map((t) => (
								<option key={t} value={t}>
									{TIMEFRAME_LABELS[t]}
								</option>
							))}
						</select>
					}
				/>
			)}
			{hasAccount && (
				<OrdersPanel
					key={runId}
					runId={runId}
					active={visible}
					selectedId={selectedOrder}
					onSelect={setSelectedOrder}
				/>
			)}
			{selectedOrder && (
				<TradeOrderSheet
					runId={runId}
					id={selectedOrder}
					initial={orders?.find((o) => o.id === selectedOrder) ?? null}
					onSelect={setSelectedOrder}
					onClose={() => setSelectedOrder(null)}
				/>
			)}
			{adding && runs && (
				<AddRunDialog
					strategies={strategies}
					hasLive={runs.some((r) => r.mode === "live")}
					onClose={() => setAdding(false)}
					onCreated={(s) => {
						setAdding(false);
						set(s);
						selectRun(s.id);
						showToast(`「${s.name}」のタブを追加した`);
					}}
				/>
			)}
			{toast && (
				<div
					role="status"
					className="fixed inset-x-4 bottom-[calc(84px+env(safe-area-inset-bottom))] z-90 mx-auto w-fit max-w-[calc(100%-32px)] rounded-[10px] bg-text px-4 py-2.5 text-[13px] font-semibold text-bg shadow-lg lg:bottom-6"
				>
					{toast}
				</div>
			)}
		</HomeFrame>
	);
}

/** タブ（運用）の並びと追加のボタン。並びきらなければ横にスクロールする */
function RunTabs({
	runs,
	current,
	onSelect,
	onAdd,
}: {
	runs: AutoTradingStatus[] | null;
	current: number | null;
	onSelect: (id: number) => void;
	onAdd: () => void;
}) {
	if (!runs)
		return <Skeleton className="h-[42px] rounded-[10px] lg:col-span-2" />;
	return (
		<div className="flex min-w-0 items-center gap-2 lg:col-span-2">
			<div
				role="tablist"
				aria-label="タブ"
				className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto rounded-[10px] bg-surface-2 p-[3px]"
			>
				{runs.map((r) => (
					<button
						key={r.id}
						type="button"
						role="tab"
						aria-selected={current === r.id}
						onClick={() => onSelect(r.id)}
						className={`flex h-9 min-w-[6.5rem] flex-1 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 text-xs whitespace-nowrap sm:text-[13px] ${current === r.id ? "bg-surface font-bold text-text shadow-sm" : "text-text-2"}`}
					>
						{r.enabled && (
							<span
								role="img"
								aria-label="稼働中"
								className="h-2 w-2 shrink-0 rounded-full bg-profit"
							/>
						)}
						<span className="max-w-[10rem] truncate">{r.name}</span>
						{r.mode === "live" && <ModeTag mode="live" />}
					</button>
				))}
			</div>
			<button
				type="button"
				aria-label="タブを追加"
				disabled={runs.length >= MAX_RUNS}
				onClick={onAdd}
				className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[10px] bg-surface-2 text-xl font-bold text-text-2 disabled:opacity-40"
			>
				＋
			</button>
		</div>
	);
}

/**
 * 注文をチャートの印にする。成行は約定するまで価格が無いので、注文中は今の価格、
 * 取り消したものはその時刻の足の終値に置く（バックテスト結果と同じ）
 */
function toMarkers(
	orders: StoredOrder[],
	bars: readonly ChartBar[],
	price: number | null,
): ChartMarker[] {
	return orders.flatMap((o) => {
		const time = orderTime(o);
		const p =
			o.fillPrice ??
			o.price ??
			(o.status === "open"
				? price
				: (bars.findLast((b) => b.time <= time)?.close ?? null));
		return p === null
			? []
			: [
					{
						id: o.id,
						side: o.side,
						status: o.status,
						time,
						price: p,
					},
				];
	});
}

/** 今の市場評価。押すとニュース画面へ */
function JudgmentPanel({ current }: { current: CurrentJudgment | null }) {
	return (
		<section aria-label="市場評価" className={PANEL}>
			<PanelHeader
				title="市場評価"
				link={{ to: "/news", label: "ニュース ›" }}
			/>
			{current === null ? (
				<Skeleton className="h-[74px]" />
			) : (
				<div className="grid grid-cols-2 gap-2">
					{JUDGES.map((j) => {
						const r = current.results[j];
						return (
							<Link
								key={j}
								to="/news"
								data-testid={`home-judge-${j}`}
								className="flex min-w-0 flex-col items-start gap-1.5 rounded-[10px] border border-line px-3 py-2.5 hover:bg-surface-2"
							>
								<span className="text-xs text-text-2">{JUDGE_LABELS[j]}</span>
								<JudgmentBadge judge={j} value={r.value} />
								<span className="num text-xs text-text-2">
									{r.average === null ? "—" : `${r.average}点`}
								</span>
							</Link>
						);
					})}
				</div>
			)}
		</section>
	);
}

/** 24時間の変化率。上がれば緑・下がれば赤 */
function Change24h({ latest }: { latest: LatestMarket | null }) {
	const change = changePercent(
		latest?.price ?? null,
		latest?.price24hAgo ?? null,
	);
	return (
		<span
			data-testid="home-change"
			className={`font-semibold ${change === null ? "text-text-2" : change >= 0 ? "text-profit" : "text-loss"}`}
		>
			{change === null ? "24h —" : `24h ${formatSignedPercent(change)}`}
		</span>
	);
}

/** 収集が止まっている間だけ出す */
function CollectorAlert({ latest }: { latest: LatestMarket | null }) {
	const trouble = latest ? collectorTrouble(latest.collector) : null;
	if (!trouble) return null;
	return (
		<div
			role="alert"
			className="flex flex-col gap-1 rounded-[10px] bg-warn px-3.5 py-3 text-xs leading-relaxed lg:col-span-2"
		>
			<b className="text-[13px]">価格の収集が止まっている</b>
			<span>{trouble.what}</span>
			<span className="num text-text-2">止まった時刻: {trouble.since}</span>
			<span className="text-text-2">{trouble.retry}</span>
		</div>
	);
}
