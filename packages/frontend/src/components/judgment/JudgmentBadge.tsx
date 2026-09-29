import type {
	AggregationRule,
	Judge,
	JudgmentValue,
} from "@trading-studio/core";
import { classify, JUDGE_LABELS, SCORE_RANGES } from "@trading-studio/core";
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
					? { background: `var(${s.solid})` }
					: judge === "risk" && value === "caution"
						? { background: `var(${s.bg})` }
						: undefined
			}
		>
			<ShapeIcon shape={s.shape} color={crisis ? "#fff" : `var(${s.solid})`} />
			{s.label}
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
					["normal", min, t.risk.caution],
					["caution", t.risk.caution, t.risk.crisis],
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
				className="relative h-2 rounded opacity-80"
				style={{ background: `linear-gradient(to right,${gradient})` }}
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
							<ShapeIcon shape={st.shape} color={`var(${st.solid})`} size={8} />
							{st.label}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
