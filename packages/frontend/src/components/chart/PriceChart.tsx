// 価格チャート。バックテスト結果とホーム（のちにペーパー・ライブも）で使う

import type { Judge } from "@trading-studio/core";
import {
	ema,
	JUDGE_LABELS,
	JUDGES,
	JUDGMENT_VALUES,
} from "@trading-studio/core";
import type {
	IChartApi,
	ISeriesApi,
	ISeriesMarkersPluginApi,
	Time,
	UTCTimestamp,
} from "lightweight-charts";
import {
	createChart,
	createSeriesMarkers,
	LineSeries,
	TickMarkType,
} from "lightweight-charts";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatDateTime } from "../../format";
import { formatInt } from "../../lib/number";
import { ShapeIcon } from "../judgment/JudgmentBadge";
import { valueStyle } from "../judgment/judgment-style";
import { Segmented } from "../ui";
import type { ChartBar, ChartMarker, ChartRange } from "./chart-data";
import {
	barStep,
	CHART_RANGES,
	fromChartTime,
	markerColorVar,
	markerShape,
	snapToBar,
	toChartTime,
	toSlots,
	visibleRange,
} from "./chart-data";
import { JudgeLayer, stripArea } from "./judge-layer";
import type { BarJudgments } from "./judgment-data";
import { slotAligned } from "./judgment-data";

type Props = {
	bars: readonly ChartBar[];
	markers?: readonly ChartMarker[];
	/** 戦略の条件にある EMA の本数。空なら EMA の表示切り替えを出さない */
	emaPeriods?: readonly number[];
	selectedId?: string | null;
	onMarker?: (m: ChartMarker) => void;
	/** 同じ画面に複数置くときの区別（ラジオボタンの name に使う） */
	name?: string;
	/** 表示期間を呼び出し側で持つとき（期間に合わせて足を取り直すホームなど） */
	range?: ChartRange;
	onRangeChange?: (r: ChartRange) => void;
	/** 表示期間の切り替えの下に置く操作（ホームの粒度の切り替えなど） */
	toolbar?: ReactNode;
	/**
	 * 表示範囲を合わせ直すきっかけ。指定すると、足が更新されても値が変わるまで利用者の拡大・移動を保つ
	 * （数秒ごとに最新の価格を足すホームで、そのたびに表示範囲が戻らないように）
	 */
	viewKey?: string;
	/** 足ごとの AI 判定（足の並びと同じ長さ）。無ければ背景と帯を出さない */
	judgments?: BarJudgments | null;
	/** 背景に塗る判定。残りは下の帯に並べる */
	bg?: Judge;
	onBgChange?: (j: Judge) => void;
};

const EMA_VARS = ["--color-ema1", "--color-ema2"] as const;
const emaVar = (j: number) => EMA_VARS[j % 2] as string;

// Tailwind のクラスはキャンバスに効かないので、テーマの CSS 変数を読んで渡す
function cssVar(name: string): string {
	return getComputedStyle(document.documentElement)
		.getPropertyValue(name)
		.trim();
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** 目盛りの文字。時刻は JST へずらしてあるので UTC として読む */
function tickLabel(t: Time, type: TickMarkType): string {
	const d = new Date((t as number) * 1000);
	switch (type) {
		case TickMarkType.Year:
			return String(d.getUTCFullYear());
		// 月の変わり目も他の日付と同じ形にする。「2026/8」は左端で切れると「6/8」と読めてしまう
		case TickMarkType.Month:
		case TickMarkType.DayOfMonth:
			return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
		default:
			return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
	}
}

function chartColors() {
	return {
		layout: {
			background: { color: cssVar("--color-surface") },
			textColor: cssVar("--color-text-2"),
		},
		grid: { horzLines: { color: cssVar("--color-grid") } },
		rightPriceScale: { borderColor: cssVar("--color-line") },
		timeScale: { borderColor: cssVar("--color-line") },
	};
}

const NO_MARKERS: readonly ChartMarker[] = [];
const NO_PERIODS: readonly number[] = [];

/** チャートの高さの最小値（px）。下の className の h-[260px] と揃える */
const MIN_CHART_PX = 260;

/** アイコンを押したとみなす距離（px）。指で押すため広めにとる */
const HIT_PX = 18;

export function PriceChart({
	bars,
	markers = NO_MARKERS,
	emaPeriods = NO_PERIODS,
	selectedId = null,
	onMarker,
	name = "chart",
	range: controlledRange,
	onRangeChange,
	toolbar,
	viewKey,
	judgments = null,
	bg = "trend",
	onBgChange,
}: Props) {
	const box = useRef<HTMLDivElement>(null);
	const chartRef = useRef<{
		chart: IChartApi;
		price: ISeriesApi<"Line">;
		marks: ISeriesMarkersPluginApi<Time>;
		emas: ISeriesApi<"Line">[];
		layer: JudgeLayer;
	} | null>(null);
	const [ownRange, setOwnRange] = useState<ChartRange>("all");
	const range = controlledRange ?? ownRange;
	const setRange = onRangeChange ?? setOwnRange;
	const [emaOn, setEmaOn] = useState(true);
	const [cursor, setCursor] = useState<number | null>(null);
	const [themeTick, setThemeTick] = useState(0);

	const barTimes = useMemo(() => bars.map((b) => b.time), [bars]);
	const slots = useMemo(() => toSlots(barTimes), [barTimes]);
	// 呼び出し側が毎回新しい配列を渡しても、本数が同じなら計算し直さない
	const emaKey = emaPeriods.join(",");
	// biome-ignore lint/correctness/useExhaustiveDependencies: emaPeriods の中身は emaKey で見る
	const emaValues = useMemo(() => {
		const closes = bars.map((b) => b.close);
		return emaPeriods.map((n) => ema(closes, n));
	}, [bars, emaKey]);
	const showEma = emaOn && emaPeriods.length > 0;

	// マーカーの押下判定は描画ライブラリのイベントから呼ぶので、最新の値を ref で渡す
	const latest = useRef({ markers, onMarker, barTimes, slots, onBgChange });
	latest.current = { markers, onMarker, barTimes, slots, onBgChange };

	// チャートを作る（1回だけ）
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const chart = createChart(el, {
			autoSize: true,
			layout: {
				fontFamily: cssVar("--font-mono"),
				fontSize: 11,
			},
			grid: { vertLines: { visible: false } },
			timeScale: {
				timeVisible: true,
				secondsVisible: false,
				rightOffset: 3,
				minBarSpacing: 0.001,
				tickMarkFormatter: tickLabel,
			},
			localization: {
				locale: "ja-JP",
				priceFormatter: (p: number) => formatInt(p),
				timeFormatter: (t: Time) => formatDateTime(fromChartTime(t as number)),
			},
			crosshair: { mode: 0 },
			handleScale: {
				pinch: true,
				mouseWheel: true,
				axisPressedMouseMove: true,
			},
			handleScroll: {
				mouseWheel: true,
				pressedMouseMove: true,
				horzTouchDrag: true,
				vertTouchDrag: false,
			},
		});
		chart.applyOptions(chartColors());
		const price = chart.addSeries(LineSeries, {
			color: cssVar("--color-price"),
			lineWidth: 2,
			crosshairMarkerRadius: 4,
		});
		const marks = createSeriesMarkers(price, []);
		const layer = new JudgeLayer(cssVar);
		price.attachPrimitive(layer);
		chartRef.current = { chart, price, marks, emas: [], layer };

		chart.subscribeCrosshairMove((p) => {
			// 価格の系列は全部の枠を持つので、論理位置がそのまま枠の番号になる
			const n = latest.current.slots.length;
			if (p.logical === undefined || n === 0) {
				setCursor(null);
				return;
			}
			setCursor(Math.min(n - 1, Math.max(0, Math.round(p.logical))));
		});
		chart.subscribeClick((p) => {
			const { markers: ms, onMarker: cb, barTimes: times } = latest.current;
			if (!p.point) return;
			const strip = layer.stripAt(p.point.y);
			if (strip) {
				latest.current.onBgChange?.(strip);
				return;
			}
			if (!cb) return;
			let hit = ms.find((m) => m.id === p.hoveredObjectId) ?? null;
			if (!hit) {
				// アイコンは小さいので、近くを押したものも拾う
				let best = HIT_PX;
				for (const m of ms) {
					const at = snapToBar(times, m.time);
					if (at === null) continue;
					const x = chart
						.timeScale()
						.timeToCoordinate(toChartTime(at) as UTCTimestamp);
					if (x === null) continue;
					const y = price.priceToCoordinate(m.price);
					// アイコンは線の上下に離れて描かれるので、縦方向は余裕を持たせる
					const dy = y === null ? 0 : Math.max(0, Math.abs(y - p.point.y) - 24);
					const d = Math.hypot(x - p.point.x, dy);
					if (d < best) {
						best = d;
						hit = m;
					}
				}
			}
			if (hit) cb(hit);
		});

		const onTheme = () => setThemeTick((n) => n + 1);
		window.addEventListener("themechange", onTheme);
		return () => {
			window.removeEventListener("themechange", onTheme);
			chart.remove();
			chartRef.current = null;
		};
	}, []);

	// 価格
	useEffect(() => {
		chartRef.current?.price.setData(
			slots.map((s) => {
				const time = toChartTime(s.time) as UTCTimestamp;
				// 足の無い枠は値を持たせず、線を途切れさせる
				return s.bar === null
					? { time }
					: { time, value: (bars[s.bar] as ChartBar).close };
			}),
		);
	}, [bars, slots]);

	// EMA の線
	useEffect(() => {
		const c = chartRef.current;
		if (!c) return;
		for (const s of c.emas) c.chart.removeSeries(s);
		c.emas = [];
		if (!showEma) return;
		emaValues.forEach((values, j) => {
			const s = c.chart.addSeries(LineSeries, {
				color: cssVar(emaVar(j)),
				lineWidth: 1,
				priceLineVisible: false,
				lastValueVisible: false,
				crosshairMarkerVisible: false,
			});
			s.setData(
				slots.map((slot) => {
					const time = toChartTime(slot.time) as UTCTimestamp;
					const v =
						slot.bar === null ? Number.NaN : (values[slot.bar] as number);
					// 本数が足りない先頭と足の無い枠は空けて描く
					return Number.isNaN(v) ? { time } : { time, value: v };
				}),
			);
			c.emas.push(s);
		});
	}, [slots, emaValues, showEma]);

	// 注文のアイコン。themeTick は色を読み直すため
	// biome-ignore lint/correctness/useExhaustiveDependencies: themeTick の変化で色を読み直す
	useEffect(() => {
		const c = chartRef.current;
		if (!c) return;
		const list = markers.flatMap((m) => {
			const at = snapToBar(barTimes, m.time);
			if (at === null) return [];
			const sel = m.id === selectedId;
			return [
				{
					id: m.id,
					time: toChartTime(at) as UTCTimestamp,
					position:
						m.side === "buy" ? ("belowBar" as const) : ("aboveBar" as const),
					shape: markerShape(m),
					color: cssVar(markerColorVar(m)),
					size: sel ? 2 : 1,
					text: sel ? "選択中" : "",
				},
			];
		});
		list.sort((a, b) => a.time - b.time);
		c.marks.setMarkers(list);
	}, [markers, barTimes, selectedId, themeTick]);

	// AI 判定の背景と帯。帯の分だけ価格の線を上へ寄せる
	const hasJudgments = judgments !== null;
	// 描画拡張は論理位置（枠の番号）で塗るので、判定を枠の並びに置き直す。足の無い枠は塗らない
	const slotJudgments = useMemo(
		() => (judgments ? slotAligned(judgments, slots) : null),
		[judgments, slots],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: themeTick の変化で色を読み直す
	useEffect(() => {
		const c = chartRef.current;
		if (!c) return;
		c.layer.setData(slotJudgments, bg);
		// 帯の高さは px で決まるが余白は割合で渡すので、チャートが最も低いとき（スマホ幅）に合わせる
		const bottom = hasJudgments
			? (stripArea(true) + 14) / (MIN_CHART_PX - 28)
			: 0.1;
		c.price.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom } });
	}, [slotJudgments, bg, hasJudgments, themeTick]);

	// 表示期間。viewKey があれば、足が届き始めたときと viewKey が変わったときだけ合わせ直す
	const hasBars = barTimes.length > 0;
	const zoomKey = viewKey ?? barTimes;
	// biome-ignore lint/correctness/useExhaustiveDependencies: 合わせ直すきっかけは zoomKey と hasBars で決める
	useEffect(() => {
		const c = chartRef.current;
		if (!c) return;
		const step = barStep(barTimes) ?? 3_600_000;
		const r = visibleRange(range, slots.length, step);
		if (r) c.chart.timeScale().setVisibleLogicalRange(r);
		else c.chart.timeScale().fitContent();
	}, [range, zoomKey, hasBars]);

	// テーマの切り替えに追従する
	useEffect(() => {
		const c = chartRef.current;
		if (!c || themeTick === 0) return;
		c.chart.applyOptions(chartColors());
		c.price.applyOptions({ color: cssVar("--color-price") });
		c.emas.forEach((s, j) => {
			s.applyOptions({ color: cssVar(emaVar(j)) });
		});
	}, [themeTick]);

	const slot = slots[cursor ?? slots.length - 1] ?? null;
	const shown = slot?.bar ?? null;
	const bar = shown === null ? null : bars[shown];

	return (
		<div className="flex flex-col gap-2">
			<Segmented
				name={`${name}-range`}
				label="表示する期間"
				options={CHART_RANGES}
				value={range}
				onChange={setRange}
			/>
			{toolbar}
			{judgments && (
				<fieldset className="flex flex-wrap items-center gap-2">
					<legend className="sr-only">背景に使う判定</legend>
					<span aria-hidden="true" className="text-xs text-text-2">
						背景
					</span>
					{JUDGES.map((j) => (
						<button
							key={j}
							type="button"
							aria-pressed={j === bg}
							onClick={() => onBgChange?.(j)}
							className="h-8 rounded-full border border-line px-3 text-xs font-semibold text-text-2 aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-white dark:aria-pressed:text-accent-ink"
						>
							{JUDGE_LABELS[j]}
						</button>
					))}
				</fieldset>
			)}
			{emaPeriods.length > 0 && (
				<div className="flex items-center gap-2">
					<span className="text-xs text-text-2">表示</span>
					<button
						type="button"
						aria-pressed={emaOn}
						onClick={() => setEmaOn((v) => !v)}
						className="h-8 rounded-full border border-line px-3 text-xs font-semibold text-text-2 aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-white dark:aria-pressed:text-accent-ink"
					>
						EMA
					</button>
				</div>
			)}
			<div
				aria-live="off"
				className="num flex min-h-5 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs"
			>
				{slot && !bar && (
					<>
						<span className="text-text-2">{formatDateTime(slot.time)}</span>
						<span className="font-semibold text-text-2">データなし</span>
					</>
				)}
				{bar && (
					<>
						<span className="text-text-2">{formatDateTime(bar.time)}</span>
						<span className="font-semibold">¥{formatInt(bar.close)}</span>
						{judgments &&
							JUDGES.map((j) => {
								const v = judgments[j][shown as number] ?? null;
								if (v === null) return null;
								const st = valueStyle(j, v);
								return (
									<span
										key={j}
										data-testid={`chart-judgment-${j}`}
										className="flex items-center gap-1"
									>
										<ShapeIcon shape={st.shape} color={`var(${st.solid})`} />
										{j === "sentiment" ? `感情 ${v}` : st.label}
									</span>
								);
							})}
						{showEma &&
							emaPeriods.map((n, j) => {
								const v = emaValues[j]?.[shown as number];
								return (
									<span key={n} className="flex items-center gap-1">
										<i
											className="inline-block h-[3px] w-2.5"
											style={{ background: `var(${emaVar(j)})` }}
										/>
										EMA{n}{" "}
										{v === undefined || Number.isNaN(v) ? "—" : formatInt(v)}
									</span>
								);
							})}
					</>
				)}
			</div>
			<div
				ref={box}
				role="img"
				aria-label="価格チャート"
				className="h-[260px] w-full lg:h-[360px]"
			/>
			{(onMarker || showEma || judgments) && (
				<details className="rounded-[10px] border border-line px-3 py-2 text-xs">
					<summary className="cursor-pointer font-semibold">凡例</summary>
					<div className="mt-2 flex flex-col gap-2">
						{onMarker && (
							<LegendRow title="注文">
								<LegendItem
									shape="up"
									colorVar="--color-buy"
									label="買い約定"
								/>
								<LegendItem
									shape="down"
									colorVar="--color-sell"
									label="売り約定"
								/>
								<LegendItem
									shape="circle"
									colorVar="--color-buy"
									label="注文中"
								/>
								<LegendItem
									shape="square"
									colorVar="--color-cancel"
									label="取消"
								/>
							</LegendRow>
						)}
						{showEma && (
							<LegendRow title="EMA" note="戦略の条件で使う移動平均">
								{emaPeriods.map((n, j) => (
									<span key={n} className="flex items-center gap-1">
										<i
											className="inline-block h-[3px] w-3"
											style={{ background: `var(${emaVar(j)})` }}
										/>
										EMA {n}
									</span>
								))}
							</LegendRow>
						)}
						{judgments &&
							JUDGES.map((j) => (
								<LegendRow
									key={j}
									title={JUDGE_LABELS[j]}
									note={j === bg ? "背景" : "下の帯"}
								>
									{JUDGMENT_VALUES[j].map((v) => {
										const st = valueStyle(j, v);
										return (
											<span key={v} className="flex items-center gap-1">
												<i
													className="inline-block h-2.5 w-3 rounded-sm"
													style={
														j === bg
															? {
																	background: `var(${st.bg})`,
																	outline: `1px solid var(${st.solid})`,
																}
															: { background: `var(${st.solid})` }
													}
												/>
												{st.label}
											</span>
										);
									})}
								</LegendRow>
							))}
					</div>
				</details>
			)}
			<p className="text-xs text-text-2">
				{onMarker && "アイコンをタップで詳細 · "}
				{judgments && "下の帯をタップで背景と入れ替え · "}
				ピンチ / ホイールで拡大
			</p>
		</div>
	);
}

function LegendRow({
	title,
	note,
	children,
}: {
	title: string;
	note?: string;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1">
			<div className="flex gap-2">
				<b>{title}</b>
				{note && <span className="text-text-2">{note}</span>}
			</div>
			<div className="flex flex-wrap gap-x-3 gap-y-1">{children}</div>
		</div>
	);
}

const SHAPES = {
	up: <polygon points="2,14 14,14 8,2" />,
	down: <polygon points="2,2 14,2 8,14" />,
	circle: <circle cx="8" cy="8" r="6" />,
	square: <rect x="2.5" y="2.5" width="11" height="11" rx="1" />,
};

function LegendItem({
	shape,
	colorVar,
	label,
}: {
	shape: keyof typeof SHAPES;
	colorVar: string;
	label: string;
}) {
	return (
		<span className="flex items-center gap-1">
			<svg
				width="10"
				height="10"
				viewBox="0 0 16 16"
				aria-hidden="true"
				style={{ fill: `var(${colorVar})` }}
			>
				{SHAPES[shape]}
			</svg>
			{label}
		</span>
	);
}
