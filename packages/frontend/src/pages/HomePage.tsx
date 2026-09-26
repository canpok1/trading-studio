import type {
	LatestMarket,
	StoredStrategy,
	TimeframeCoverage,
} from "@trading-studio/backend";
import type { Timeframe } from "@trading-studio/core";
import { emaPeriods, TIMEFRAME_LABELS, TIMEFRAMES } from "@trading-studio/core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../api";
import type { ChartBar, ChartRange } from "../components/chart/chart-data";
import { PriceChart } from "../components/chart/PriceChart";
import { EmptyState, ErrorState, Skeleton } from "../components/States";
import { Button, Card, Segmented } from "../components/ui";
import { formatDateTime } from "../format";
import {
	changePercent,
	collectorTrouble,
	RANGE_DEFAULT_TIMEFRAME,
	tooManyTimeframes,
	usableTimeframe,
	withLatestPrice,
} from "../lib/home";
import { formatInt, formatSignedPercent } from "../lib/number";
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

const NO_PERIODS: number[] = [];

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
		<div className="mx-auto flex max-w-[720px] flex-col gap-3.5 px-4 pt-4 pb-2 lg:grid lg:max-w-none lg:grid-cols-[minmax(340px,400px)_minmax(0,1fr)] lg:items-start lg:gap-x-5 lg:px-6">
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
	const [strategies, setStrategies] = useState(initial);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const active = strategies.active;

	const [range, setRange] = useState<ChartRange>("1d");
	// null は「おまかせ」（戦略の粒度、戦略が無ければ期間に合わせた粒度）
	const [chosenTf, setChosenTf] = useState<Timeframe | null>(null);
	const disabledTfs = useMemo(
		() => tooManyTimeframes(range, counts),
		[range, counts],
	);
	const timeframe = usableTimeframe(
		chosenTf ?? active?.params.timeframe ?? RANGE_DEFAULT_TIMEFRAME[range],
		disabledTfs,
	);

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
		} catch (e) {
			if (my === barsSeq.current) setBarsError(errorMessage(e));
		}
	}, [api, timeframe, range, history, barsKey]);
	useEffect(() => {
		if (visible) loadBars();
	}, [visible, loadBars]);
	useInterval(loadBars, BARS_MS, visible);

	// 粒度・期間を切り替えた直後は前の条件の足が残っている。届くまでは最新の価格も EMA も重ねない
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
		} catch (e) {
			setSaveError(errorMessage(e));
		} finally {
			setSaving(false);
		}
	};

	const noData =
		latest !== null && latest.price === null && bars?.bars.length === 0;

	return (
		<HomeFrame>
			<PriceHeader latest={latest} />
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
			<Card className="flex flex-col gap-2 lg:col-start-1">
				<label htmlFor="home-strategy" className="text-[15px] font-bold">
					運用する戦略
				</label>
				<select
					id="home-strategy"
					className="h-11 w-full rounded-lg border border-line bg-surface px-3 text-[15px] font-semibold"
					value={active?.id ?? ""}
					disabled={saving}
					onChange={(e) =>
						choose(e.target.value === "" ? null : Number(e.target.value))
					}
				>
					<option value="">未選択</option>
					{strategies.list.map((s) => (
						<option key={s.id} value={s.id}>
							{s.name}（{TIMEFRAME_LABELS[s.params.timeframe]}）
						</option>
					))}
				</select>
				{saveError && (
					<p role="alert" className="text-xs font-semibold text-loss">
						保存できなかった: {saveError}
					</p>
				)}
				{strategies.list.length === 0 && (
					<p className="text-xs text-text-2">
						戦略がまだ無い。戦略設定で作ると選べる
					</p>
				)}
			</Card>
			<section
				aria-label="価格チャート"
				className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-line bg-surface p-3 lg:col-start-2 lg:row-span-6 lg:row-start-1 lg:sticky lg:top-4"
			>
				{barsError && !bars ? (
					<ErrorState
						what="チャートの足を読み込めなかった"
						next={barsError}
						action={<Button onClick={loadBars}>もう一度読み込む</Button>}
					/>
				) : noData ? (
					<EmptyState
						title="収集を始めたばかりでデータがない"
						description="価格を受け取ると、ここにチャートが出る"
					/>
				) : (
					<PriceChart
						bars={shownBars}
						emaPeriods={fresh ? emaShown : NO_PERIODS}
						name="home-chart"
						range={range}
						onRangeChange={setRange}
						viewKey={bars?.key ?? ""}
						toolbar={
							<>
								<Segmented
									name="home-timeframe"
									label="足の粒度"
									size="sm"
									options={TF_OPTIONS}
									value={timeframe}
									disabledValues={disabledTfs}
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
			</section>
		</HomeFrame>
	);
}

/** 見出し・現在値・24時間の変化率。現在値は上がれば緑・下がれば赤で一瞬光る */
function PriceHeader({ latest }: { latest: LatestMarket | null }) {
	const [now, setNow] = useState(() => Date.now());
	useInterval(() => setNow(Date.now()), 1_000, true);
	const price = latest?.price ?? null;
	const prev = useRef<number | null>(null);
	const [flash, setFlash] = useState<"up" | "down" | null>(null);
	useEffect(() => {
		const before = prev.current;
		prev.current = price;
		if (before === null || price === null || before === price) return;
		setFlash(price > before ? "up" : "down");
		const id = setTimeout(() => setFlash(null), 800);
		return () => clearTimeout(id);
	}, [price]);
	const change = changePercent(price, latest?.price24hAgo ?? null);

	return (
		<div className="flex items-end justify-between gap-2 lg:col-start-1">
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="text-xs text-text-2">
					BTC/JPY · Coincheck ·{" "}
					<span className="num">{formatDateTime(now)}</span>
				</span>
				<span
					data-testid="home-price"
					className={`num text-[28px] font-semibold tracking-tight transition-colors duration-300 ${flash === "up" ? "text-profit" : flash === "down" ? "text-loss" : ""}`}
				>
					{price === null ? "—" : `¥${formatInt(price)}`}
				</span>
			</div>
			<span
				className={`num pb-1.5 text-xs font-semibold ${change === null ? "text-text-2" : change >= 0 ? "text-profit" : "text-loss"}`}
			>
				{change === null ? "24h —" : `24h ${formatSignedPercent(change)}`}
			</span>
		</div>
	);
}

/** 収集が止まっている間だけ出す */
function CollectorAlert({ latest }: { latest: LatestMarket | null }) {
	const trouble = latest ? collectorTrouble(latest.collector) : null;
	if (!trouble) return null;
	return (
		<div
			role="alert"
			className="flex flex-col gap-1 rounded-[10px] bg-warn px-3.5 py-3 text-xs leading-relaxed lg:col-start-1"
		>
			<b className="text-[13px]">価格の収集が止まっている</b>
			<span>{trouble.what}</span>
			<span className="num text-text-2">止まった時刻: {trouble.since}</span>
			<span className="text-text-2">{trouble.retry}</span>
		</div>
	);
}
