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
	emaPeriods,
	formatBtc,
	JUDGE_LABELS,
	JUDGES,
	TIMEFRAME_LABELS,
	TIMEFRAME_MS,
	TIMEFRAMES,
} from "@trading-studio/core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useApi } from "../api";
import { OrderRow, orderTime, Stat } from "../components/backtest/OrderViews";
import type { ChartBar, ChartMarker } from "../components/chart/chart-data";
import { alignJudgments } from "../components/chart/judgment-data";
import { PriceChart } from "../components/chart/PriceChart";
import { AutoTradingCard } from "../components/home/AutoTradingCard";
import { JudgmentBadge } from "../components/judgment/JudgmentBadge";
import { EmptyState, ErrorState, Skeleton } from "../components/States";
import {
	MODE_LABELS,
	ModeTag,
	TradeOrderSheet,
} from "../components/trading/TradeViews";
import { Button, Card, Segmented } from "../components/ui";
import { useChartBg } from "../lib/chart-bg";
import {
	changePercent,
	collectorTrouble,
	HOME_DEFAULT_TIMEFRAME,
	HOME_INITIAL_SPAN_MS,
	judgmentsFrom,
	loadRange,
	withLatestPrice,
} from "../lib/home";
import { formatInt, formatSignedInt, formatSignedPercent } from "../lib/number";
import { useTradingOrders, useTradingStatus } from "../lib/trading";
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
/** EMA の計算のために期間の前に足す本数（最も長い EMA の何倍か） */
const EMA_HISTORY_FACTOR = 3;
const MAX_HISTORY = 1_000;
/** チャートの印に読む注文の数。直近の一覧もここから取る */
const MARKER_ORDERS = 300;
const RECENT_ORDERS = 3;

const NO_PERIODS: number[] = [];

const PANEL =
	"flex min-w-0 flex-col gap-2.5 rounded-xl border border-line bg-surface p-3";
/** PC 幅では、表示の切り替えを状態の右に、チャート本体を下の段に2列ぶち抜きで置く */
const SPLIT = {
	controls: "rounded-xl border border-line bg-surface p-3 lg:self-stretch",
	chart: "rounded-xl border border-line bg-surface p-3 lg:col-span-2",
};

const TF_OPTIONS = TIMEFRAMES.map(
	(t) => [t, TIMEFRAME_LABELS[t].replace("足", "")] as const,
);

type Strategies = { list: StoredStrategy[]; active: StoredStrategy | null };

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
		const [list, active, coverage] = await Promise.all([
			api.api.strategies
				.$get()
				.then((r) => readJson<{ strategies: StoredStrategy[] }>(r)),
			api.api.strategies.active
				.$get()
				.then((r) => readJson<{ strategy: StoredStrategy | null }>(r)),
			api.api.data.coverage
				.$get()
				.then((r) => readJson<{ timeframes: TimeframeCoverage[] }>(r)),
		]);
		const counts: Partial<Record<Timeframe, number>> = {};
		for (const c of coverage.timeframes) counts[c.timeframe] = c.count;
		return {
			strategies: { list: list.strategies, active: active.strategy },
			counts,
		};
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
		<div className="mx-auto flex max-w-[720px] flex-col gap-3.5 px-4 pt-4 pb-2 lg:grid lg:max-w-none lg:grid-cols-[minmax(340px,400px)_minmax(0,1fr)] lg:items-start lg:gap-5 lg:px-6">
			<h1 className="sr-only">ホーム</h1>
			{children}
		</div>
	);
}

function HomeBody({
	latest,
	latestError,
	onRetryLatest,
	strategies: initial,
	counts,
	visible,
}: {
	latest: LatestMarket | null;
	latestError: string | null;
	onRetryLatest: () => void;
	strategies: Strategies;
	counts: Partial<Record<Timeframe, number>>;
	visible: boolean;
}) {
	const api = useApi();
	const { status: trading, refresh: refreshTrading } = useTradingStatus();
	const mode = trading?.mode ?? "paper";
	const { orders } = useTradingOrders(
		{ mode, limit: MARKER_ORDERS },
		visible && trading !== null,
	);
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
	const [strategies, setStrategies] = useState(initial);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const active = strategies.active;

	// null は「おまかせ」（戦略の粒度、戦略が無ければ既定の粒度）
	const [chosenTf, setChosenTf] = useState<Timeframe | null>(null);
	const timeframe =
		chosenTf ?? active?.params.timeframe ?? HOME_DEFAULT_TIMEFRAME;
	const range = loadRange(timeframe, counts);

	// EMA は運用する戦略の粒度で描くときだけ出す（別の粒度では本数の意味がずれる）
	const periods = useMemo(
		() => (active ? emaPeriods(active.params) : []),
		[active],
	);
	const emaShown =
		active !== null && timeframe === active.params.timeframe ? periods : [];
	const history = Math.min(
		MAX_HISTORY,
		Math.max(0, ...emaShown) * EMA_HISTORY_FACTOR,
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

	const choose = async (id: number | null) => {
		setSaving(true);
		setSaveError(null);
		try {
			const r = await api.api.strategies.active
				.$put({ json: { id } })
				.then((res) => readJson<{ strategy: StoredStrategy | null }>(res));
			setStrategies((s) => ({ ...s, active: r.strategy }));
			setChosenTf(null);
			// オフ中に出す「次の判定」は運用する戦略の粒度で決まる
			refreshTrading();
		} catch (e) {
			setSaveError(errorMessage(e));
		} finally {
			setSaving(false);
		}
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
		() => toMarkers(orders ?? [], latest?.price ?? null),
		[orders, latest],
	);

	const noData =
		latest !== null && latest.price === null && bars?.bars.length === 0;

	return (
		<HomeFrame>
			<div className="flex flex-col gap-3.5">
				<CollectorAlert latest={latest} />
				{latestError && (
					<div
						role="alert"
						className="flex items-center gap-3 rounded-[10px] bg-warn px-3.5 py-3 text-xs"
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
				<AutoTradingCard
					strategies={strategies.list}
					active={active}
					saving={saving}
					onChoose={choose}
					onToast={showToast}
				/>
				{saveError && (
					<p role="alert" className="text-xs font-semibold text-loss">
						保存できなかった: {saveError}
					</p>
				)}
				{trading && (
					<PositionCard
						account={trading.account}
						price={latest?.price ?? null}
					/>
				)}
				{current && <JudgmentTiles current={current} />}
			</div>
			{barsError && !bars ? (
				<section aria-label="価格チャート" className={`${PANEL} lg:col-span-2`}>
					<ErrorState
						what="チャートの足を読み込めなかった"
						next={barsError}
						action={<Button onClick={loadBars}>もう一度読み込む</Button>}
					/>
				</section>
			) : noData ? (
				<section aria-label="価格チャート" className={`${PANEL} lg:col-span-2`}>
					<EmptyState
						title="収集を始めたばかりでデータがない"
						description="価格を受け取ると、ここにチャートが出る"
					/>
				</section>
			) : (
				<PriceChart
					bars={shownBars}
					emaPeriods={fresh ? emaShown : NO_PERIODS}
					initialSpanMs={HOME_INITIAL_SPAN_MS}
					viewKey={bars?.key ?? ""}
					currentPrice={latest?.price ?? null}
					judgments={barJudgments}
					markers={markers}
					selectedId={selectedOrder}
					onMarker={(m) => setSelectedOrder(m.id)}
					bg={bg}
					onBgChange={setBg}
					split={SPLIT}
					latestNote={<Change24h latest={latest} />}
					toolbar={
						<>
							<Segmented
								name="home-timeframe"
								label="足の粒度"
								size="sm"
								options={TF_OPTIONS}
								value={timeframe}
								onChange={setChosenTf}
							/>
							{active && periods.length > 0 && emaShown.length === 0 && (
								<p className="text-xs text-text-2">
									EMA は戦略の粒度（
									{TIMEFRAME_LABELS[active.params.timeframe]}）でだけ表示する
								</p>
							)}
						</>
					}
				/>
			)}
			<RecentOrders
				mode={mode}
				orders={orders}
				selectedId={selectedOrder}
				onSelect={setSelectedOrder}
			/>
			{selectedOrder && (
				<TradeOrderSheet
					mode={mode}
					id={selectedOrder}
					initial={orders?.find((o) => o.id === selectedOrder) ?? null}
					onSelect={setSelectedOrder}
					onClose={() => setSelectedOrder(null)}
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

/** 注文をチャートの印にする。成行の注文中は価格が無いので今の価格に置く */
function toMarkers(orders: StoredOrder[], price: number | null): ChartMarker[] {
	return orders.flatMap((o) => {
		const p = o.fillPrice ?? o.price ?? price;
		return p === null
			? []
			: [
					{
						id: o.id,
						side: o.side,
						status: o.status,
						time: orderTime(o),
						price: p,
					},
				];
	});
}

/** 保有・平均取得・評価損益。評価損益は手数料を含めず、今の価格で評価する */
function PositionCard({
	account,
	price,
}: {
	account: AutoTradingStatus["account"];
	price: number | null;
}) {
	const { quantity, entryPrice } = account.position;
	const pnl =
		quantity > 0 && entryPrice !== null && price !== null
			? Math.round(((price - entryPrice) * quantity) / 100_000_000)
			: null;
	return (
		<section
			aria-label={`${MODE_LABELS[account.mode]}の保有`}
			className="grid grid-cols-3 gap-2 rounded-xl border border-line bg-surface px-4 py-3.5"
		>
			<Stat label="保有" value={`${formatBtc(quantity)}`} />
			<Stat
				label="平均取得"
				value={entryPrice === null ? "—" : formatInt(entryPrice)}
			/>
			<Stat
				label="評価損益"
				value={pnl === null ? "—" : `${formatSignedInt(pnl)}円`}
				tone={pnl === null ? "" : pnl >= 0 ? "text-profit" : "text-loss"}
			/>
		</section>
	);
}

/** 直近の注文・約定。「すべて」で取引画面へ */
function RecentOrders({
	mode,
	orders,
	selectedId,
	onSelect,
}: {
	mode: AutoTradingStatus["mode"];
	orders: StoredOrder[] | null;
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	return (
		<section
			aria-label="直近の注文・約定"
			className="flex flex-col gap-2 lg:col-span-2"
		>
			<div className="flex items-center justify-between gap-2">
				<h2 className="text-[15px] font-bold">直近の注文・約定</h2>
				<Link
					to="/trades"
					className="h-9 px-1.5 text-[13px] leading-9 font-semibold text-accent"
				>
					すべて
				</Link>
			</div>
			<div className="overflow-hidden rounded-xl border border-line">
				{orders === null ? (
					<Skeleton className="m-3 h-10" />
				) : orders.length === 0 ? (
					<p className="bg-surface px-4 py-6 text-center text-sm text-text-2">
						{MODE_LABELS[mode]}の注文はまだない
					</p>
				) : (
					orders
						.slice(0, RECENT_ORDERS)
						.map((o) => (
							<OrderRow
								key={o.id}
								order={o}
								selected={o.id === selectedId}
								onClick={() => onSelect(o.id)}
							/>
						))
				)}
			</div>
		</section>
	);
}

/** 今の判定3つ。押すと AI判定画面へ */
function JudgmentTiles({ current }: { current: CurrentJudgment }) {
	return (
		<section aria-label="AI判定" className="grid grid-cols-3 gap-2">
			{JUDGES.map((j) => {
				const r = current.results[j];
				return (
					<Link
						key={j}
						to="/ai"
						data-testid={`home-judge-${j}`}
						className="flex min-w-0 flex-col items-start gap-1.5 rounded-xl border border-line bg-surface px-3 py-2.5"
					>
						<span className="text-xs text-text-2">{JUDGE_LABELS[j]}</span>
						<JudgmentBadge judge={j} value={r.value} />
						<span className="num text-xs text-text-2">
							{r.average === null ? "—" : `${r.average}点`}
						</span>
					</Link>
				);
			})}
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
			className="flex flex-col gap-1 rounded-[10px] bg-warn px-3.5 py-3 text-xs leading-relaxed"
		>
			<b className="text-[13px]">価格の収集が止まっている</b>
			<span>{trouble.what}</span>
			<span className="num text-text-2">止まった時刻: {trouble.since}</span>
			<span className="text-text-2">{trouble.retry}</span>
		</div>
	);
}
