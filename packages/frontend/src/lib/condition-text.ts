// 条件セットを1行で表す文字列。結果の要約と、戦略へ上書きするときの差分に使う

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
	formatBtc,
	JUDGMENT_VALUE_LABELS,
	ORDER_TYPE_LABELS,
	TIMEFRAME_LABELS,
} from "@trading-studio/core";

const JUDGE_SHORT = { trend: "トレンド", risk: "リスク", sentiment: "感情" };

const freq = (f: Frequency) => `${f.value}${FREQUENCY_UNIT_LABELS[f.unit]}`;

export function frequencyText(p: ConditionSet): string {
	return `判定 なし${freq(p.frequency.flat)}/あり${freq(p.frequency.holding)}ごと`;
}

/** 判定頻度より粗い間隔でしか判定できないときの説明 */
export function stepLimitedText(step: Timeframe): string {
	return `判定頻度より細かい過去データが無いため、${TIMEFRAME_LABELS[step]}の終わりごとにしか判定しない。判定頻度どおりに試すには、より細かい足の CSV を取り込む`;
}

export function conditionText(c: Condition): string {
	switch (c.type) {
		case "emaCross":
			return `EMA${c.fast}/${c.slow}${c.direction === "up" ? "上抜け" : "下抜け"}`;
		case "breakout":
			return `${c.lookback}本の${c.direction === "high" ? "高値上抜け" : "安値下抜け"}`;
		case "entryChange":
			return `${c.direction === "up" ? "+" : "−"}${c.percent}%`;
		case "judgment":
			return `${JUDGE_SHORT[c.judge]}${c.values.map((v) => JUDGMENT_VALUE_LABELS[v] ?? v).join("/")}`;
	}
}

/** 集計ルールの要約（バックテスト結果に出す） */
export function ruleText(r: AggregationRule): string {
	const t = r.thresholds;
	return `集計 ${r.windowHours}時間・半減期${r.halfLifeHours}時間 · トレンド ${t.trend.down}/${t.trend.up} · リスク ${t.risk.caution}/${t.risk.crisis} · 感情 ${t.sentiment.minus2}/${t.sentiment.minus1}/${t.sentiment.plus1}/${t.sentiment.plus2}`;
}

export function buyOrderText(o: BuyOrder): string {
	return o.type === "limit"
		? `指値 −${o.belowPercent}%・${o.expireBars}本で取消`
		: ORDER_TYPE_LABELS[o.type];
}

export function groupText(g: ConditionGroup): string {
	return (
		g.conditions
			.map(conditionText)
			.join(g.match === "all" ? " かつ " : " または ") || "なし"
	);
}

/** 変わった項目だけを [項目名, 変更前, 変更後] で返す */
export function conditionDiff(
	before: ConditionSet,
	after: ConditionSet,
): [string, string, string][] {
	const rows: [string, string, string][] = [
		[
			"足の粒度",
			TIMEFRAME_LABELS[before.timeframe],
			TIMEFRAME_LABELS[after.timeframe],
		],
		["判定の頻度", frequencyText(before), frequencyText(after)],
		["買い注文する条件", groupText(before.buy), groupText(after.buy)],
		[
			"買いの注文方法",
			buyOrderText(before.buyOrder),
			buyOrderText(after.buyOrder),
		],
		[
			"売り（利確）の条件",
			groupText(before.takeProfit),
			groupText(after.takeProfit),
		],
		[
			"売り（損切り）の条件",
			groupText(before.stopLoss),
			groupText(after.stopLoss),
		],
		[
			"1回の注文量",
			`${formatBtc(before.orderSize)} BTC`,
			`${formatBtc(after.orderSize)} BTC`,
		],
	];
	return rows.filter(([, a, b]) => a !== b);
}
