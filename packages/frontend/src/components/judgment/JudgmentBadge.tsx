import type {
	AggregationRule,
	Judge,
	JudgmentValue,
} from "@trading-studio/core";
import { classify, JUDGE_LABELS } from "@trading-studio/core";
import type { Shape } from "./judgment-style";
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
}: {
	shape: Shape;
	color: string;
	size?: number;
}) {
	return (
		<svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
			{SHAPES[shape](color)}
		</svg>
	);
}

/** 判定の値のバッジ */
export function JudgmentBadge<J extends Judge>({
	judge,
	value,
}: {
	judge: J;
	value: JudgmentValue<J>;
}) {
	const s = valueStyle(judge, value);
	const crisis = judge === "risk" && value === "crisis";
	const label =
		judge === "sentiment" ? `感情 ${s.label.split(" ")[0]}` : s.label;
	return (
		<span
			data-testid={`badge-${judge}`}
			className={`inline-flex h-[26px] items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold whitespace-nowrap ${crisis ? "text-white" : "bg-surface-2 text-text"}`}
			style={
				crisis
					? { background: `var(${s.solid})` }
					: judge === "trend" || (judge === "risk" && value === "caution")
						? { background: `var(${s.bg})` }
						: undefined
			}
		>
			<ShapeIcon shape={s.shape} color={crisis ? "#fff" : `var(${s.solid})`} />
			{label}
		</span>
	);
}

/** 観点ごとの点数のチップ。null は関係なし */
export function ScoreChip({
	judge,
	score,
	rule,
}: {
	judge: Judge;
	score: number | null;
	rule: AggregationRule;
}) {
	if (score === null) {
		return (
			<span
				title="関係なし"
				className="inline-flex h-[26px] items-center gap-1.5 rounded-full bg-surface-2 px-2.5 text-xs whitespace-nowrap text-text-2"
			>
				{JUDGE_LABELS[judge]} <b className="num">—</b>
			</span>
		);
	}
	const s = valueStyle(judge, classify(judge, score, rule));
	return (
		<span className="inline-flex h-[26px] items-center gap-1.5 rounded-full bg-surface-2 px-2.5 text-xs whitespace-nowrap">
			<ShapeIcon
				shape={s.shape === "oct" ? "tri" : s.shape}
				color={`var(${s.solid})`}
			/>
			{JUDGE_LABELS[judge]} <b className="num">{score}</b>
		</span>
	);
}

/** 0〜100 の帯をしきい値ごとに判定の色で塗り、平均点の位置に印を付ける */
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
	const zones: [string, number, number][] =
		judge === "trend"
			? [
					["down", 0, t.trend.down],
					["range", t.trend.down, t.trend.up],
					["up", t.trend.up, 100],
				]
			: judge === "risk"
				? [
						["normal", 0, t.risk.caution],
						["caution", t.risk.caution, t.risk.crisis],
						["crisis", t.risk.crisis, 100],
					]
				: [
						["-2", 0, t.sentiment.minus2],
						["-1", t.sentiment.minus2, t.sentiment.minus1],
						["0", t.sentiment.minus1, t.sentiment.plus1],
						["+1", t.sentiment.plus1, t.sentiment.plus2],
						["+2", t.sentiment.plus2, 100],
					];
	const gradient = zones
		.map(
			([v, a, b]) =>
				`var(${valueStyle(judge, v as JudgmentValue).solid}) ${a}% ${b}%`,
		)
		.join(",");
	return (
		<div
			aria-hidden="true"
			className="relative h-2 rounded opacity-80"
			style={{ background: `linear-gradient(to right,${gradient})` }}
		>
			{score !== null && (
				<i
					className="absolute -top-1 -ml-0.5 h-4 w-1 rounded-sm bg-text shadow-[0_0_0_2px_var(--color-surface)]"
					style={{ left: `${score}%` }}
				/>
			)}
		</div>
	);
}
