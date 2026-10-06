import type {
	AggregationRule,
	Duration,
	Judge,
	JudgmentValue,
} from "@trading-studio/core";
import {
	classify,
	DURATION_LABELS,
	JUDGE_LABELS,
	SCORE_RANGES,
} from "@trading-studio/core";
import type { Shape, ValueStyle } from "./judgment-style";
import { valueStyle } from "./judgment-style";

const SHAPES: Record<Shape, (fill: string) => React.ReactNode> = {
	up: (f) => <polygon points="6,1 11,10 1,10" style={{ fill: f }} />,
	down: (f) => <polygon points="1,2 11,2 6,11" style={{ fill: f }} />,
	bar: (f) => <rect x="1" y="5" width="10" height="2.5" style={{ fill: f }} />,
	circle: (f) => <circle cx="6" cy="6" r="5" style={{ fill: f }} />,
	tri: (f) => <polygon points="6,0.5 11.5,11 0.5,11" style={{ fill: f }} />,
	oct: (f) => (
		<polygon
			points="3.5,.5 8.5,.5 11.5,3.5 11.5,8.5 8.5,11.5 3.5,11.5 .5,8.5 .5,3.5"
			style={{ fill: f }}
		/>
	),
	sq: (f) => (
		<rect x="1" y="1" width="10" height="10" rx="2" style={{ fill: f }} />
	),
};

/** 判定の記号。色だけに頼らず形でも見分けられるようにする */
export function ShapeIcon({
	shape,
	color,
	size = 10,
	edge,
}: {
	shape: Shape;
	color: string;
	size?: number;
	/** 背景に沈む色のときの縁取りの色 */
	edge?: string;
}) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 12 12"
			aria-hidden="true"
			style={edge ? { stroke: edge, strokeWidth: 1 } : undefined}
		>
			{SHAPES[shape](color)}
		</svg>
	);
}

/** 塗りが背景に沈む色（ダークの危機）だけ縁取る。-edge が無い色は縁なし */
function edgeShadow(s: ValueStyle): string {
	return `inset 0 0 0 1px var(${s.solid}-edge, transparent)`;
}

/** 記号の縁。カードの地に近い色（ライトの中立・平常、ダークの危機）でも形が見えるようにする */
export function iconEdge(s: ValueStyle): string {
	return `var(${s.solid}-edge, var(--color-line))`;
}

/** 判定の値のバッジ。値の名前（強気・警戒など）で観点が分かるので観点名は付けない */
export function JudgmentBadge<J extends Judge>({
	judge,
	value,
}: {
	judge: J;
	value: JudgmentValue<J>;
}) {
	const s = valueStyle(judge, value);
	const crisis = judge === "risk" && value === "crisis";
	return (
		<span
			data-testid={`badge-${judge}`}
			className={`inline-flex h-[26px] items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold whitespace-nowrap ${crisis ? "text-white" : "bg-surface-2 text-text"}`}
			style={
				crisis
					? { background: `var(${s.solid})`, boxShadow: edgeShadow(s) }
					: judge === "risk" && value !== "calm"
						? { background: `var(${s.bg})` }
						: undefined
			}
		>
			<ShapeIcon
				shape={s.shape}
				color={crisis ? "#fff" : `var(${s.solid})`}
				edge={crisis ? undefined : iconEdge(s)}
			/>
			{s.label}
		</span>
	);
}

/** チップは横に並べるので、観点の名前を短くする */
const CHIP_LABELS: Record<Judge, string> = {
	sentiment: "センチ",
	risk: "リスク",
};

const CHIP =
	"inline-flex h-[26px] items-center gap-1.5 rounded-full bg-surface-2 px-2.5 text-xs whitespace-nowrap";

/** 観点ごとの点数のチップ。程度が一目で分かるよう、市場評価の帯と同じ色で塗る */
export function ScoreChip({
	judge,
	score,
	rule,
}: {
	judge: Judge;
	score: number;
	rule: AggregationRule;
}) {
	const s = valueStyle(judge, classify(judge, score, rule));
	return (
		<span
			data-testid={`score-chip-${judge}`}
			className={CHIP}
			style={{
				background: `var(${s.solid})`,
				color: `var(${s.solid}-ink)`,
				boxShadow: edgeShadow(s),
			}}
		>
			{CHIP_LABELS[judge]} <b className="num">{score}</b>
		</span>
	);
}

/** 影響の持続のチップ。中立・平常のチップと同じ色にする。none（相場に関係ない）は薄く出す */
export function DurationChip({ duration }: { duration: Duration }) {
	return (
		<span
			className={`${CHIP} ${duration === "none" ? "opacity-60" : ""}`}
			style={{
				background: "var(--color-s0)",
				color: "var(--color-s0-ink)",
			}}
		>
			持続 <b>{DURATION_LABELS[duration]}</b>
		</span>
	);
}

/** 点数の範囲の帯をしきい値ごとに判定の色で塗り、平均点の位置に印を付ける。下に色の意味を1行で添える */
export function ZoneBar({
	judge,
	rule,
	score,
}: {
	judge: Judge;
	rule: AggregationRule;
	score: number | null;
}) {
	const t = rule.thresholds;
	const { min, max } = SCORE_RANGES[judge];
	const pct = (v: number) => ((v - min) / (max - min)) * 100;
	const zones: [string, number, number][] =
		judge === "risk"
			? [
					["calm", min, t.risk.mild],
					["mild", t.risk.mild, t.risk.alert],
					["alert", t.risk.alert, t.risk.severe],
					["severe", t.risk.severe, t.risk.crisis],
					["crisis", t.risk.crisis, max],
				]
			: [
					["-2", min, t.sentiment.minus2],
					["-1", t.sentiment.minus2, t.sentiment.minus1],
					["0", t.sentiment.minus1, t.sentiment.plus1],
					["+1", t.sentiment.plus1, t.sentiment.plus2],
					["+2", t.sentiment.plus2, max],
				];
	const styles = zones.map(([v]) => valueStyle(judge, v as JudgmentValue));
	const gradient = zones
		.map(([, a, b], i) => `var(${styles[i]?.solid}) ${pct(a)}% ${pct(b)}%`)
		.join(",");
	return (
		<div className="flex flex-col gap-1.5">
			<div
				aria-hidden="true"
				className="relative h-2 rounded"
				style={{
					background: `linear-gradient(to right,${gradient})`,
					boxShadow: "0 0 0 1px var(--color-line)",
				}}
			>
				{score !== null && (
					<i
						className="absolute -top-1 -ml-0.5 h-4 w-1 rounded-sm bg-text shadow-[0_0_0_2px_var(--color-surface)]"
						style={{ left: `${pct(score)}%` }}
					/>
				)}
			</div>
			<ul
				aria-label={`${JUDGE_LABELS[judge]}の色の意味`}
				className="flex justify-between gap-1 text-[10px] text-text-2"
			>
				{styles.map((st) => {
					return (
						<li
							key={st.label}
							className="inline-flex items-center gap-1 whitespace-nowrap"
						>
							<ShapeIcon
								shape={st.shape}
								color={`var(${st.solid})`}
								size={8}
								edge={iconEdge(st)}
							/>
							{st.label}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
