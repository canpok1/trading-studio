// 条件セットを1行で表す文字列。結果の要約に使う

import type {
	AggregationRule,
	BuyOrder,
	Condition,
	ConditionGroup,
	ConditionSet,
	Frequency,
	Timeframe,
} from "@trading-studio/core";
import {
	FREQUENCY_UNIT_LABELS,
	JUDGMENT_VALUE_LABELS,
	ORDER_TYPE_LABELS,
	TIMEFRAME_LABELS,
} from "@trading-studio/core";

const JUDGE_SHORT = { sentiment: "センチメント", risk: "リスク" };

const freq = (f: Frequency) => `${f.value}${FREQUENCY_UNIT_LABELS[f.unit]}`;

export function frequencyText(p: ConditionSet): string {
	return `判定 なし${freq(p.frequency.flat)}/あり${freq(p.frequency.holding)}ごと`;
}

/** 判定の間隔より粗い間隔でしか判定できないときの説明 */
export function stepLimitedText(step: Timeframe): string {
	return `判定の間隔より細かい過去データが無いため、${TIMEFRAME_LABELS[step]}の終わりごとにしか判定しない。判定の間隔どおりに試すには、より細かい足の CSV を取り込む`;
}

export function conditionText(c: Condition): string {
	switch (c.type) {
		case "emaCross":
			return `EMA${c.fast}/${c.slow}${c.direction === "up" ? "上抜け" : "下抜け"}`;
		case "breakout":
			return `${c.lookback}本の${c.direction === "high" ? "高値上抜け" : "安値下抜け"}`;
		case "rsi":
			return `RSI${c.period} ${c.threshold}${c.direction === "above" ? "以上" : "以下"}`;
		case "emaPosition":
			return `EMA${c.period}より${c.direction === "above" ? "上" : "下"}`;
		case "emaSlope":
			return `EMA${c.period}が${c.bars}本前より${c.percent > 0 ? `${c.percent}%以上` : ""}${c.direction === "up" ? "上向き" : "下向き"}`;
		case "bollinger":
			return `BB${c.period}/${c.sigma}σ${c.band === "upper" ? "上限以上" : "下限以下"}`;
		case "entryChange":
			return `${c.direction === "up" ? "+" : "−"}${c.percent}%`;
		case "trailingStop":
			return `最高値−${c.percent}%`;
		case "holdingBars":
			return `${c.bars}本保有`;
		case "judgment":
			return `${JUDGE_SHORT[c.judge]} ${c.values.map((v) => JUDGMENT_VALUE_LABELS[v] ?? v).join("/")}`;
	}
}

/** 評価ルールの要約（バックテスト結果に出す） */
export function ruleText(r: AggregationRule): string {
	const t = r.thresholds;
	return `評価ルール 期間${r.windowHours}時間・半減期${r.halfLifeHours}時間 · センチメントの境目 ${t.sentiment.minus2}/${t.sentiment.minus1}/${t.sentiment.plus1}/${t.sentiment.plus2} · リスクの境目 ${t.risk.caution}/${t.risk.crisis}`;
}

export function buyOrderText(o: BuyOrder): string {
	const lines = o.lines.map((l) =>
		l.type === "limit" ? `指値 −${l.belowPercent}%` : ORDER_TYPE_LABELS[l.type],
	);
	return o.lines.some((l) => l.type === "limit")
		? `${lines.join("・")}・${o.expireBars}本で取消`
		: lines.join("・");
}

export function groupText(g: ConditionGroup): string {
	return (
		g.conditions
			.map(conditionText)
			.join(g.match === "all" ? " かつ " : " または ") || "なし"
	);
}
