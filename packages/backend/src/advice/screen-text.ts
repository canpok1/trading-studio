// AI に渡す設定を、画面の項目名・グループ名で書く。改善案を画面でそのまま設定し直せる言葉で出してもらうため

import type {
	AggregationRule,
	Condition,
	ConditionSet,
	FeeRates,
	Frequency,
} from "@trading-studio/core";
import {
	CONDITION_GROUP_LABELS,
	CONDITION_GROUPS,
	FREQUENCY_UNIT_LABELS,
	formatBtc,
	formatYen,
	JUDGE_LABELS,
	JUDGMENT_VALUE_LABELS,
	TIMEFRAME_LABELS,
} from "@trading-studio/core";

const freq = (f: Frequency) => `${f.value}${FREQUENCY_UNIT_LABELS[f.unit]}`;
const pct = (ppm: number) => `${ppm / 10_000}%`;

/** 条件1つ。戦略画面の条件の文言に揃える */
export function conditionScreenText(c: Condition): string {
	switch (c.type) {
		case "emaCross":
			return `短期EMA ${c.fast} 本が 長期EMA ${c.slow} 本を${c.direction === "up" ? "上抜けた" : "下抜けた"}`;
		case "breakout":
			return `終値が直近 ${c.lookback} 本の${c.direction === "high" ? "最高値を上抜けた" : "最安値を下抜けた"}`;
		case "entryChange":
			return `買値から ${c.percent} % ${c.direction === "up" ? "上がった" : "下がった"}`;
		case "judgment":
			return `${JUDGE_LABELS[c.judge]}判定が ${c.values.map((v) => JUDGMENT_VALUE_LABELS[v] ?? v).join("・")} のどれか`;
	}
}

/** 戦略設定。戦略画面の見出しと項目の並びどおりに書く */
export function conditionSetScreenText(p: ConditionSet): string[] {
	const lines = [
		"### 足と判定の頻度",
		`- 足の粒度: ${TIMEFRAME_LABELS[p.timeframe]}`,
		`- ポジションなしのとき: ${freq(p.frequency.flat)}ごとに買いの条件を判定`,
		`- ポジションありのとき: ${freq(p.frequency.holding)}ごとに売りの条件を判定`,
		"### 1回の注文量",
		`- ${formatBtc(p.orderSize)} BTC`,
		"### リスク上限",
		`- 1日の損失上限（円）: ${formatYen(p.dailyLossLimit)}`,
	];
	for (const key of CONDITION_GROUPS) {
		const g = p[key];
		lines.push(
			`### ${CONDITION_GROUP_LABELS[key]}（組み合わせ方: ${g.match === "all" ? "すべて満たす" : "どれか1つ"}）`,
		);
		if (g.conditions.length === 0) lines.push("- 条件なし");
		g.conditions.forEach((c, i) => {
			lines.push(`${i + 1}. ${conditionScreenText(c)}`);
		});
		if (key === "buy") {
			const o = p.buyOrder;
			lines.push(
				o.type === "limit"
					? `- 注文方法: 指値。現在値から ${o.belowPercent} % 下に指値。${o.expireBars} 本のあいだ約定しなければ取消`
					: "- 注文方法: 成行",
			);
		}
	}
	return lines;
}

/** 実行画面の「口座」の項目 */
export function accountScreenText(initialCash: number, fees: FeeRates) {
	return [
		`- 初期資金（円）: ${formatYen(initialCash)}`,
		`- 手数料率: 指値 ${pct(fees.limitPpm)}・成行 ${pct(fees.marketPpm)}`,
	];
}

/** 設定 > ニュース > 集計ルール の項目 */
export function ruleScreenText(r: AggregationRule): string[] {
	const t = r.thresholds;
	return [
		`- 平均のとり方: 期間 ${r.windowHours} 時間・半減期 ${r.halfLifeHours} 時間`,
		`- トレンド: 上昇 ${t.trend.up} 点以上・下落 ${t.trend.down} 点以下（間はレンジ）`,
		`- リスク: 警戒 ${t.risk.caution} 点以上・危機 ${t.risk.crisis} 点以上（未満は平常）`,
		`- センチメント: +2 ${t.sentiment.plus2} 点以上・+1 ${t.sentiment.plus1} 点以上・−1 ${t.sentiment.minus1} 点未満・−2 ${t.sentiment.minus2} 点未満（間は 0）`,
	];
}
