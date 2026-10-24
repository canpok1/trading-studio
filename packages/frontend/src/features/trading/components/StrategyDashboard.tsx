import type {
	AutoTradingStatus,
	CurrentJudgment,
	JudgmentSeries,
	LatestMarket,
	StoredOrder,
	StoredStrategy,
	TimeframeCoverage,
} from "@trading-studio/backend";
import type { Instrument, Timeframe } from "@trading-studio/core";
import {
	BTC_JPY,
	COLLECTED_INSTRUMENTS,
	LIVE_AVAILABLE,
	TIMEFRAME_LABELS,
	TIMEFRAME_MS,
	TIMEFRAMES,
} from "@trading-studio/core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	ChartBar,
	ChartMarker,
} from "../../../shared/components/chart/chart-data";
import { alignJudgments } from "../../../shared/components/chart/judgment-data";
import type { InstrumentChoice } from "../../../shared/components/chart/PriceChart";
import { PriceChart } from "../../../shared/components/chart/PriceChart";
import { orderTime } from "../../../shared/components/OrderViews";
import {
	EmptyState,
	ErrorState,
	Skeleton,
} from "../../../shared/components/States";
import { Button, Segmented } from "../../../shared/components/ui";
import { useApi } from "../../../shared/lib/api";
import { useChartBg } from "../../../shared/lib/chart-bg";
import { useChartIndicators } from "../../../shared/lib/chart-indicators";
import {
	initialSpanMs,
	useChartTimeframe,
} from "../../../shared/lib/chart-timeframe";
import { formatSignedPercent } from "../../../shared/lib/number";
import { chartTriggers } from "../../../shared/lib/strategy-watch";
import {
	useStrategyWatch,
	useTradingOrders,
	useTradingPerformance,
	useTradingStatus,
} from "../../../shared/lib/trading";
import {
	errorMessage,
	readJson,
	useAsync,
	useInterval,
	usePageVisible,
} from "../../../shared/lib/useAsync";
import {
	changePercent,
	collectorTrouble,
	judgmentsFrom,
	loadRange,
	withLatestPrice,
} from "../utils/home";
import { AccountPanel } from "./AccountPanel";
import { OrdersPanel } from "./OrdersPanel";
import { PANEL, PanelHeader } from "./Panel";
import { PerformancePanel } from "./PerformancePanel";
import { NextMovesCard, StrategyWatchPanel } from "./StrategyWatch";
import {
	MarketEvalInline,
	MarketEvalTile,
	TotalPnlTile,
	UnrealizedPnlTile,
	UnrealizedTotalTile,
} from "./SummaryTiles";
import { TradeOrderSheet } from "./TradeViews";

const NO_PRICES: readonly number[] = [];
const NO_TRIGGERS: ReturnType<typeof chartTriggers> = [];

/** 最新価格を問い合わせる間隔 */
const LATEST_MS = 5_000;
/** チャートの足を取り直す間隔。その間は最新の価格を最後の足に反映する */
const BARS_MS = 60_000;
/** EMA・RSI の計算のために期間の前に足す本数（最も長い本数の何倍か） */
const EMA_HISTORY_FACTOR = 3;
const MAX_HISTORY = 1_000;
/** チャートの印に読む注文の数 */
const MARKER_ORDERS = 300;

/** 見る銘柄の既定。候補のうち保有中の先頭、無ければ候補の先頭。戦略が無ければ null（既定の銘柄） */
function defaultInstrument(run: AutoTradingStatus | null): string | null {
	if (!run) return null;
	const held = run.account.holdings.find((h) => h.position.quantity > 0);
	return held?.instrument ?? run.instrument.id;
}

/** 銘柄の指定。API の型に出していないので、変数に入れて渡す */
const instrumentQuery = (id: string | null): { instrument?: string } =>
	id ? { instrument: id } : {};

/**
 * 戦略1つの要点・次の動き・チャート・見張り・成績・口座・注文。
 * layout が home なら市場評価とチャートだけにし、strategyId の戦略の印（買値・発動価格・注文）をチャートに描く（null なら印なし）。
 * head は最上部に全幅で出すもので、トーストを出す関数を受け取る
 */
export function StrategyDashboard({
	strategyId,
	layout = "strategy",
	head,
	children,
}: {
	strategyId: number | null;
	layout?: "strategy" | "home";
	head?: (toast: (message: string) => void) => ReactNode;
	children?: ReactNode;
}) {
	const api = useApi();
	const visible = usePageVisible();
	const { runs } = useTradingStatus();
	const run =
		strategyId === null
			? null
			: (runs?.find((r) => r.id === strategyId) ?? null);
	// 候補が2つ以上の戦略は見る銘柄を選べる（ADR 0037）。選ぶまで・戦略を切り替えたら既定の銘柄
	const [chosen, setChosen] = useState<{
		strategyId: number | null;
		id: string;
	} | null>(null);
	const instrumentId =
		(chosen?.strategyId === strategyId &&
		run?.instruments.some((i) => i.id === chosen.id)
			? chosen.id
			: null) ?? defaultInstrument(run);
	// 既定の銘柄は保有で変わるので、戦略ごとに最初の1回で固定し、定期の取り直しで表示を飛ばさない
	const fixedDefault =
		chosen?.strategyId === strategyId ? null : defaultInstrument(run);
	useEffect(() => {
		if (fixedDefault !== null) setChosen({ strategyId, id: fixedDefault });
	}, [strategyId, fixedDefault]);
	// 戦略の候補外の銘柄はチャートだけで描く。たまに見る用途なので保存せず、戦略や見る銘柄を切り替えたら戻す
	const [outside, setOutside] = useState<{
		strategyId: number | null;
		id: string;
	} | null>(null);
	// ホームでカードを替えて戻ったときに前の選択を出さない
	useEffect(() => {
		if (strategyId !== undefined) setOutside(null);
	}, [strategyId]);
	const candidates = run?.instruments.map((i) => i.id) ?? [BTC_JPY.id];
	const chartOutside =
		outside?.strategyId === strategyId && !candidates.includes(outside.id)
			? outside.id
			: null;
	const chooseInstrument = useCallback(
		(id: string) => {
			setOutside(null);
			setChosen({ strategyId, id });
		},
		[strategyId],
	);
	// 候補の銘柄を選ぶのは見る銘柄の切り替えと同じにし、チャートとページで別の銘柄を見せない
	const chooseChartInstrument = (id: string) => {
		if (!candidates.includes(id)) setOutside({ strategyId, id });
		else if (run) chooseInstrument(id);
		else setOutside(null);
	};

	const page = useLatest(instrumentId, visible, true);
	const chart = useLatest(chartOutside, visible, chartOutside !== null);
	const latest = page.latest;

	// 戦略と、全期間の足の数（選べる粒度の判定に使う）
	const loadSetup = useCallback(async () => {
		const [list, coverage] = await Promise.all([
			api.api.strategies
				.$get()
				.then((r) => readJson<{ strategies: StoredStrategy[] }>(r)),
			api.api.data.coverage
				.$get({ query: {} })
				.then((r) => readJson<{ timeframes: TimeframeCoverage[] }>(r)),
		]);
		const counts: Partial<Record<Timeframe, number>> = {};
		for (const c of coverage.timeframes) counts[c.timeframe] = c.count;
		return { strategies: list.strategies, counts };
	}, [api]);
	const setup = useAsync(loadSetup);
	// ホームは開いたまま他の画面へ移るので、戻ったときに戦略の条件（チャートの指標の既定）を読み直す
	const shown = useRef(visible);
	const reloadSetup = setup.reload;
	useEffect(() => {
		if (visible && !shown.current) reloadSetup();
		shown.current = visible;
	}, [visible, reloadSetup]);

	if (setup.state.kind === "error") {
		return (
			<DashboardFrame>
				<ErrorState
					what="ホームのデータを読み込めなかった"
					next={setup.state.message}
					action={<Button onClick={setup.reload}>もう一度読み込む</Button>}
				/>
			</DashboardFrame>
		);
	}
	if (setup.state.kind === "loading") {
		return (
			<DashboardFrame>
				<div
					role="status"
					aria-label="読み込み中"
					className="flex flex-col gap-3"
				>
					<Skeleton className="h-4 w-1/2" />
					<Skeleton className="h-9 w-2/3" />
					<Skeleton className="h-[320px] w-full" />
				</div>
			</DashboardFrame>
		);
	}
	return (
		<DashboardBody
			run={run}
			instrumentId={instrumentId}
			onInstrument={chooseInstrument}
			chartOutside={chartOutside}
			onChartInstrument={chooseChartInstrument}
			chartLatest={chartOutside ? chart.latest : latest}
			layout={layout}
			head={head}
			latest={latest}
			latestError={page.error ?? (chartOutside ? chart.error : null)}
			onRetryLatest={() => {
				page.reload();
				if (chartOutside) chart.reload();
			}}
			strategies={setup.state.data.strategies}
			counts={setup.state.data.counts}
			visible={visible}
		>
			{children}
		</DashboardBody>
	);
}

/** 最新価格。どの銘柄の価格かを持ち、切り替え直後に前の銘柄の価格を出さない。id が null なら既定の銘柄 */
function useLatest(id: string | null, visible: boolean, enabled: boolean) {
	const api = useApi();
	const [loaded, setLoaded] = useState<{
		instrument: string | null;
		latest: LatestMarket;
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	const seq = useRef(0);
	const reload = useCallback(async () => {
		const my = ++seq.current;
		try {
			const r = await api.api.market.latest
				.$get({ query: instrumentQuery(id) })
				.then((res) => readJson<LatestMarket>(res));
			if (my !== seq.current) return;
			setLoaded({ instrument: id, latest: r });
			setError(null);
		} catch (e) {
			if (my === seq.current) setError(errorMessage(e));
		}
	}, [api, id]);
	const on = visible && enabled;
	useEffect(() => {
		if (on) reload();
	}, [on, reload]);
	useInterval(reload, LATEST_MS, on);
	return {
		latest: loaded?.instrument === id ? loaded.latest : null,
		error: enabled ? error : null,
		reload,
	};
}

function DashboardFrame({ children }: { children: ReactNode }) {
	return (
		<div className="mx-auto flex max-w-[720px] flex-col gap-3.5 px-4 pt-4 pb-2 lg:grid lg:max-w-none lg:grid-cols-2 lg:items-stretch lg:gap-4 lg:px-6">
			{children}
		</div>
	);
}

function DashboardBody({
	run,
	instrumentId,
	onInstrument,
	chartOutside,
	onChartInstrument,
	chartLatest,
	layout,
	head,
	children,
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
	run: AutoTradingStatus | null;
	/** 見る銘柄の id。null なら既定の銘柄 */
	instrumentId: string | null;
	onInstrument: (id: string) => void;
	/** チャートだけで描いている戦略の候補外の銘柄。null なら見る銘柄を描く */
	chartOutside: string | null;
	onChartInstrument: (id: string) => void;
	/** チャートに描く銘柄の最新価格 */
	chartLatest: LatestMarket | null;
	layout: "strategy" | "home";
	head?: (toast: (message: string) => void) => ReactNode;
	children?: ReactNode;
}) {
	const api = useApi();
	const runId = run?.id ?? 0;
	const multi = (run?.instruments.length ?? 0) > 1;
	// 候補が2つ以上なら、見張り・印・口座は選んだ銘柄のもの
	const viewed = run && multi ? viewOf(run, instrumentId) : run;
	// リアルが使えない間、リアルの戦略は口座・成績・注文を出さない
	const hasAccount = run !== null && !(run.mode === "live" && !LIVE_AVAILABLE);
	// ホームは印だけ描き、要点・成績・口座・注文の一覧は戦略の画面で見る
	const home = layout === "home";
	const account = viewed?.account ?? null;
	// 状態は定期的に取り直すので、買値が変わったときだけ線を引き直す
	const entryKey = account?.lots.map((l) => l.entryPrice).join(",") ?? "";
	const entryPrices = useMemo(
		() => (entryKey ? entryKey.split(",").map(Number) : []),
		[entryKey],
	);
	const { orders, reload: reloadOrders } = useTradingOrders(
		{
			strategyId: runId,
			limit: MARKER_ORDERS,
			...(multi && instrumentId ? { instrument: instrumentId } : {}),
		},
		visible && hasAccount,
	);
	const perf = useTradingPerformance(runId, visible && hasAccount && !home);
	const watched = useStrategyWatch(
		runId,
		multi ? instrumentId : null,
		visible && hasAccount,
	);
	const watch = watched?.watch ?? null;
	const showMoves = hasAccount && watched !== null;
	// 見張りは定期的に取り直すので、発動価格が変わったときだけ線を引き直す
	const triggerKey = JSON.stringify(chartTriggers(watch));
	// biome-ignore lint/correctness/useExhaustiveDependencies: 発動価格が変わったとき（triggerKey）だけ作り直す
	const triggers = useMemo(() => chartTriggers(watch), [triggerKey]);
	// どの戦略の注文かを持ち、ホームで印の対象を切り替えたら前の戦略の注文の詳細を閉じる
	const [selected, setSelected] = useState<{
		runId: number;
		id: string;
	} | null>(null);
	const selectedOrder = selected?.runId === runId ? selected.id : null;
	const setSelectedOrder = (id: string | null) =>
		setSelected(id === null ? null : { runId, id });
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
	const active = strategies.find((x) => x.id === run?.id) ?? null;

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
		instrument: Instrument;
		bars: ChartBar[];
	} | null>(null);
	const [barsError, setBarsError] = useState<string | null>(null);
	// 判定は足と一緒に取り直す。読めなくても価格のチャートは出す
	const chartId = chartOutside ?? instrumentId;
	const [currents, setCurrents] = useState<
		Partial<Record<string, CurrentJudgment>>
	>({});
	const current = currents[instrumentId ?? ""] ?? null;
	const chartCurrent = currents[chartId ?? ""] ?? null;
	// どの足の条件で取った判定かを持ち、切り替え直後に別の粒度の判定を当てはめない
	const [series, setSeries] = useState<{
		key: string;
		series: JudgmentSeries;
	} | null>(null);
	const [bg, setBg] = useChartBg();
	const barsKey = `${chartId}:${timeframe}:${range}:${history}`;
	const barsSeq = useRef(0);
	const loadBars = useCallback(async () => {
		const my = ++barsSeq.current;
		const instrument = instrumentQuery(chartId);
		const barsQuery: {
			timeframe: Timeframe;
			range: typeof range;
			history: string;
			instrument?: string;
		} = { timeframe, range, history: String(history), ...instrument };
		try {
			const r = await api.api.market.bars
				.$get({ query: barsQuery })
				.then((res) =>
					readJson<{ instrument: Instrument; bars: ChartBar[] }>(res),
				);
			if (my === barsSeq.current) {
				setBars({ key: barsKey, instrument: r.instrument, bars: r.bars });
				setBarsError(null);
			}
			// 判定は読めなくても価格のチャートは出すので、失敗は表示を前のまま残すだけにする。
			// 候補外の銘柄を描いている間も、要点の市場評価は見る銘柄のものを出す
			for (const id of new Set([chartId, instrumentId])) {
				api.api.judgments.current
					.$get({ query: instrumentQuery(id) })
					.then((res) => readJson<CurrentJudgment>(res))
					.then((c) => {
						if (my === barsSeq.current)
							setCurrents((m) => ({ ...m, [id ?? ""]: c }));
					})
					.catch(() => {});
			}
			const first = r.bars[0];
			const last = r.bars.at(-1);
			if (first && last) {
				const seriesQuery: {
					from: string;
					to: string;
					timeframe: Timeframe;
					instrument?: string;
				} = {
					from: String(judgmentsFrom(first.time, last.time, timeframe)),
					// 最新の価格から作る今の足にも判定を付けるため、今の時刻まで含める
					to: String(Math.max(last.time, Date.now()) + TIMEFRAME_MS[timeframe]),
					timeframe,
					...instrument,
				};
				api.api.judgments.series
					.$get({ query: seriesQuery })
					.then((res) => readJson<JudgmentSeries>(res))
					.then((sr) => {
						if (my === barsSeq.current) setSeries({ key: barsKey, series: sr });
					})
					.catch(() => {});
			}
		} catch (e) {
			if (my === barsSeq.current) setBarsError(errorMessage(e));
		}
	}, [api, timeframe, range, history, barsKey, chartId, instrumentId]);
	useEffect(() => {
		if (visible) loadBars();
	}, [visible, loadBars]);
	useInterval(loadBars, BARS_MS, visible);

	// 粒度を切り替えた直後は前の条件の足が残っている。届くまでは最新の価格も EMA も重ねない
	const fresh = bars?.key === barsKey;
	// 銘柄を切り替えた直後の前の銘柄の足は、価格の桁が違い線や印と合わないので出さない
	const sameInstrument = bars?.key.startsWith(`${chartId}:`) ?? false;
	const shownBars = useMemo(() => {
		if (!bars || !sameInstrument) return [];
		if (!fresh) return bars.bars;
		return withLatestPrice(
			bars.bars,
			bars.instrument,
			timeframe,
			chartLatest?.price ?? null,
			chartLatest?.priceTime ?? null,
		);
	}, [bars, sameInstrument, fresh, timeframe, chartLatest]);

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
			hasAccount && !chartOutside
				? toMarkers(orders ?? [], shownBars, latest?.price ?? null)
				: [],
		[hasAccount, chartOutside, orders, shownBars, latest],
	);

	const noData =
		chartLatest !== null &&
		chartLatest.price === null &&
		bars?.bars.length === 0;

	const instrumentChoice: InstrumentChoice = {
		options: COLLECTED_INSTRUMENTS.map((i) => ({
			id: i.id,
			label: i.quantityUnit,
		})),
		value: chartId ?? BTC_JPY.id,
		onChange: onChartInstrument,
		hint: run
			? `戦略の銘柄は ${run.instruments.map((i) => i.quantityUnit).join("・")}。それ以外の銘柄は注文の印・買値・発動価格を描かない`
			: undefined,
	};
	const outsideLabel = COLLECTED_INSTRUMENTS.find(
		(i) => i.id === chartOutside,
	)?.quantityUnit;
	const notice = run && chartOutside && (
		<div
			role="status"
			className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-surface-2 px-3 py-2 text-xs"
		>
			<span className="flex-1">{outsideLabel} は戦略の候補外のため印なし</span>
			<button
				type="button"
				onClick={() => onChartInstrument(instrumentId ?? run.instrument.id)}
				className="font-semibold text-accent"
			>
				戦略の銘柄に戻す
			</button>
		</div>
	);

	const picker = run && multi && instrumentId && (
		<InstrumentPicker run={run} value={instrumentId} onChange={onInstrument} />
	);

	return (
		<DashboardFrame>
			{head?.(showToast)}
			{!home && picker && (
				<div className="flex flex-col gap-1 lg:col-span-2">
					{picker}
					<p className="text-xs text-text-2">
						損益は全銘柄の合計。市場評価・次の動き・チャート・見張り・口座は選んだ銘柄のもの
					</p>
				</div>
			)}
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
			{/* 要点: スマホは 通算損益｜含み損益、市場評価、次の動き。PC は横一列 */}
			{!home && (
				<div
					className={`grid grid-cols-2 gap-2.5 lg:col-span-2 ${
						!hasAccount
							? ""
							: showMoves
								? "sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,2fr)]"
								: "sm:grid-cols-4"
					}`}
				>
					{hasAccount && run && (
						<>
							<TotalPnlTile
								performance={perf.performance}
								error={perf.error}
								unit={run.instrument.currency.unit}
							/>
							{multi ? (
								<UnrealizedTotalTile status={run} />
							) : (
								<UnrealizedPnlTile status={run} price={latest?.price ?? null} />
							)}
						</>
					)}
					<MarketEvalTile
						current={current}
						stackAtLg={showMoves}
						className={showMoves ? "col-span-2 lg:col-span-1" : "col-span-2"}
					/>
					{hasAccount && watched && (
						<NextMovesCard
							watch={watched.watch}
							instrument={watched.instrument}
							stopped={!run?.enabled}
							className="col-span-full lg:col-span-2 xl:col-span-1"
						/>
					)}
				</div>
			)}
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
					instrument={
						(sameInstrument ? bars?.instrument : null) ??
						(chartOutside ? null : viewed?.instrument) ??
						null
					}
					bars={shownBars}
					indicators={indicators}
					hideIndicators={!fresh}
					initialSpanMs={initialSpanMs(timeframe)}
					viewKey={bars?.key ?? ""}
					currentPrice={chartLatest?.price ?? null}
					entryPrices={chartOutside ? NO_PRICES : entryPrices}
					triggers={
						hasAccount ? (chartOutside ? NO_TRIGGERS : triggers) : undefined
					}
					judgments={barJudgments}
					markers={markers}
					selectedId={selectedOrder}
					onMarker={(m) => setSelectedOrder(m.id)}
					bg={bg}
					onBgChange={setBg}
					compact
					short={home}
					headerExtra={
						home && (
							<div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
								<MarketEvalInline current={chartCurrent} />
								{picker && <div className="w-full">{picker}</div>}
							</div>
						)
					}
					latestNote={<Change24h latest={chartLatest} />}
					instrumentChoice={instrumentChoice}
					notice={notice}
					toolbarLabel={TIMEFRAME_LABELS[timeframe]}
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
			{!home && hasAccount && watched && (
				<StrategyWatchPanel
					strategyId={runId}
					watch={watched.watch}
					instrument={watched.instrument}
				/>
			)}
			{!home && hasAccount && run && (
				<>
					<PerformancePanel
						performance={perf.performance}
						error={perf.error}
						status={run}
					/>
					<AccountPanel
						key={`account-${run.id}`}
						status={viewed ?? run}
						performance={perf.performance}
						price={latest?.price ?? null}
						onToast={showToast}
						onReset={() => {
							perf.reload();
							reloadOrders();
						}}
					/>
				</>
			)}
			{!home && hasAccount && (
				<OrdersPanel
					key={runId}
					strategyId={runId}
					instruments={run?.instruments ?? []}
					instrument={instrumentId}
					active={visible}
					selectedId={selectedOrder}
					onSelect={setSelectedOrder}
				/>
			)}
			{selectedOrder && (
				<TradeOrderSheet
					strategyId={runId}
					id={selectedOrder}
					initial={orders?.find((o) => o.id === selectedOrder) ?? null}
					onSelect={setSelectedOrder}
					onClose={() => setSelectedOrder(null)}
				/>
			)}
			{children}
			{toast && (
				<div
					role="status"
					className="fixed inset-x-4 bottom-[calc(84px+env(safe-area-inset-bottom))] z-90 mx-auto w-fit max-w-[calc(100%-32px)] rounded-[10px] bg-text px-4 py-2.5 text-[13px] font-semibold text-bg shadow-lg lg:bottom-6"
				>
					{toast}
				</div>
			)}
		</DashboardFrame>
	);
}

/** 候補が2つ以上の戦略の状態を、選んだ銘柄の保有だけを持つ形にする（口座のパネルと買値の線に使う） */
function viewOf(
	run: AutoTradingStatus,
	instrumentId: string | null,
): AutoTradingStatus {
	const instrument =
		run.instruments.find((i) => i.id === instrumentId) ?? run.instrument;
	const h = run.account.holdings.find((x) => x.instrument === instrument.id);
	return {
		...run,
		instrument,
		account: {
			...run.account,
			position: h?.position ?? run.account.position,
			lots: h?.lots ?? [],
		},
	};
}

/** 見る銘柄の切り替え。保有中の銘柄には印を添える */
function InstrumentPicker({
	run,
	value,
	onChange,
}: {
	run: AutoTradingStatus;
	value: string;
	onChange: (id: string) => void;
}) {
	const held = new Set(
		run.account.holdings
			.filter((h) => h.position.quantity > 0)
			.map((h) => h.instrument),
	);
	return (
		<Segmented
			name={`instrument-${run.id}`}
			label="見る銘柄"
			options={run.instruments.map(
				(i) =>
					[
						i.id,
						`${i.quantityUnit}${held.has(i.id) ? "・保有中" : ""}`,
					] as const,
			)}
			value={value}
			onChange={onChange}
		/>
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
