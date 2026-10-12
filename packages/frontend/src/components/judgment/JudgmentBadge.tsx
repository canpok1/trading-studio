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
import type { ValueStyle } from "./judgment-style";
import { valueStyle } from "./judgment-style";

/** 塗りが背景に沈む色（ダークの危機）だけ縁取る。-edge が無い色は縁なし */
function edgeShadow(s: ValueStyle): string {
	return `inset 0 0 0 1px var(${s.solid}-edge, transparent)`;
}

/** 色見本の縁。カードの地に近い色（ライトの中立・平常、ダークの危機）でも見えるようにする */
export function swatchEdge(s: ValueStyle): string {
	return `var(${s.solid}-edge, var(--color-line))`;
}

/** 判定の値のバッジ。段階の色で塗る。値の名前（強気・警戒など）で観点が分かるので観点名は付けない */
export function JudgmentBadge<J extends Judge>({
	judge,
	value,
	score,
	small = false,
}: {
	judge: J;
	value: JudgmentValue<J>;
	/** 添える平均点。null なら付けない */
	score?: number | null;
	/** 文字の行に並べるときの小さい形 */
	small?: boolean;
}) {
	const s = valueStyle(judge, value);
	return (
		<span
			data-testid={`badge-${judge}`}
			className={`inline-flex items-center rounded-full font-semibold whitespace-nowrap ${small ? "h-5 px-2 text-[11px]" : "h-[26px] px-2.5 text-xs"}`}
			style={{
				background: `var(${s.solid})`,
				color: `var(${s.solid}-ink)`,
				boxShadow: edgeShadow(s),
			}}
		>
			{s.label}
			{score !== undefined && score !== null && (
				<span className="num font-normal">（{score}点）</span>
			)}
		</span>
	);
}

/** 横に並べる場所では観点の名前を短くする */
export const SHORT_JUDGE_LABELS: Record<Judge, string> = {
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
			{SHORT_JUDGE_LABELS[judge]} <b className="num">{score}</b>
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
			<JudgmentLegend judge={judge} />
		</div>
	);
}

/** 段階の低い順（帯の左から）。凡例・積み上げの並び */
export const LEVEL_ORDER: { [J in Judge]: readonly JudgmentValue<J>[] } = {
	risk: ["calm", "mild", "alert", "severe", "crisis"],
	sentiment: ["-2", "-1", "0", "+1", "+2"],
};

/** 段階の色の意味を1行で出す */
export function JudgmentLegend({ judge }: { judge: Judge }) {
	return (
		<ul
			aria-label={`${JUDGE_LABELS[judge]}の色の意味`}
			className="flex justify-between gap-1 text-[10px] text-text-2"
		>
			{LEVEL_ORDER[judge].map((v) => {
				const st = valueStyle(judge, v);
				return (
					<li
						key={v}
						className="inline-flex items-center gap-1 whitespace-nowrap"
					>
						<i
							aria-hidden="true"
							className="inline-block h-2 w-2 rounded-[2px]"
							style={{
								background: `var(${st.solid})`,
								boxShadow: `0 0 0 1px ${swatchEdge(st)}`,
							}}
						/>
						{st.label}
					</li>
				);
			})}
		</ul>
	);
}

/** 積み上げの塗り。地に沈む色（ライトの中立・平常など）も縁で見えるようにする */
export function levelFill(
	judge: Judge,
	value: JudgmentValue,
): React.CSSProperties {
	const st = valueStyle(judge, value);
	return {
		background: `var(${st.solid})`,
		boxShadow: `inset 0 0 0 1px ${swatchEdge(st)}`,
	};
}
