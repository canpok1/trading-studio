// AI に渡す設定を、画面の項目名・グループ名で書く。改善案を画面でそのまま設定し直せる言葉で出してもらうため

import type { Condition, ConditionSet, Frequency } from "./condition-strategy";
import {
	CONDITION_GROUP_LABELS,
	CONDITION_GROUPS,
	FREQUENCY_UNIT_LABELS,
} from "./condition-strategy";
import { formatBtc, formatYen } from "./format";
import type { AggregationRule, Judge } from "./news-judgment";
import {
	JUDGE_LABELS,
	JUDGMENT_VALUE_LABELS,
	judgmentBands,
} from "./news-judgment";
import { TIMEFRAME_LABELS } from "./timeframe";
import type { FeeRates } from "./trading";

const freq = (f: Frequency) => `${f.value}${FREQUENCY_UNIT_LABELS[f.unit]}`;
const pct = (ppm: number) => `${ppm / 10_000}%`;

/** 条件1つ。戦略画面の条件の文言に揃える */
export function conditionScreenText(c: Condition): string {
	switch (c.type) {
		case "emaCross":
			return `短期EMA ${c.fast} 本が 長期EMA ${c.slow} 本を${c.direction === "up" ? "上抜けた" : "下抜けた"}`;
		case "breakout":
			return `終値が直近 ${c.lookback} 本の${c.direction === "high" ? "最高値を上抜けた" : "最安値を下抜けた"}`;
		case "rsi":
			return `RSI ${c.period} 本が ${c.threshold} ${c.direction === "above" ? "以上" : "以下"}`;
		case "emaPosition":
			return `終値が EMA ${c.period} 本より${c.direction === "above" ? "上" : "下"}`;
		case "emaSlope":
			return `EMA ${c.period} 本が ${c.bars} 本前より${c.percent > 0 ? ` ${c.percent} % 以上` : ""}${c.direction === "up" ? "上がっている" : "下がっている"}`;
		case "bollinger":
			return `終値がボリンジャーバンド ${c.period} 本・${c.sigma}σ の${c.band === "upper" ? "上限以上" : "下限以下"}`;
		case "entryChange":
			return `買値から ${c.percent} % ${c.direction === "up" ? "上がった" : "下がった"}`;
		case "trailingStop":
			return `買ってからの最高値から ${c.percent} % 下がった`;
		case "holdingBars":
			return `買ってから ${c.bars} 本経った`;
		case "judgment":
			return `${JUDGE_LABELS[c.judge]}が ${c.values.map((v) => JUDGMENT_VALUE_LABELS[v] ?? v).join("・")} のどれか`;
	}
}

/** 戦略設定。戦略画面の見出しと項目の並びどおりに書く */
export function conditionSetScreenText(p: ConditionSet): string[] {
	const lines = [
		"### 足と判定の間隔",
		`- 足の粒度: ${TIMEFRAME_LABELS[p.timeframe]}`,
		`- ポジションなしのとき: ${freq(p.frequency.flat)}ごとに買いの条件を判定`,
		`- ポジションありのとき: ${freq(p.frequency.holding)}ごとに売りの条件を判定`,
		"### 1回の注文量",
		`- ${formatBtc(p.orderSize)} BTC`,
		`- 最大ポジション数: ${p.maxPositions}`,
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
			o.lines.forEach((l, i) => {
				lines.push(
					l.type === "limit"
						? `- 注文${i + 1}: 指値。現在値から ${l.belowPercent} % 下に指値。${o.expireBars} 本のあいだ約定しなければ取消`
						: `- 注文${i + 1}: 成行`,
				);
			});
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

/** 設定 > ニュース > 評価ルール の項目 */
export function ruleScreenText(r: AggregationRule): string[] {
	const bands = (j: Judge) =>
		judgmentBands(j, r)
			.map(
				(b) =>
					`${JUDGMENT_VALUE_LABELS[b.value]} ${b.min > b.max ? "なし" : `${b.min}〜${b.max} 点`}`,
			)
			.join("・");
	return [
		`- 平均のとり方: 期間 ${r.windowHours} 時間・半減期 ${r.halfLifeHours} 時間`,
		`- 評価基準 センチメント: ${bands("sentiment")}`,
		`- 評価基準 リスク: ${bands("risk")}`,
	];
}

/** 戦略設定の変更点。見出しごとに、変える前にしかない行と変えた後にしかない行 */
export type ConditionSetChange = {
	section: string;
	removed: string[];
	added: string[];
};

/**
 * 2つの戦略設定の違いを、画面の見出しと項目の文言で返す。
 * 条件の番号は比べない（先頭に足すと以降の番号がずれ、すべて変わったように見えるため）
 */
export function conditionSetChanges(
	before: ConditionSet,
	after: ConditionSet,
): ConditionSetChange[] {
	const a = sections(conditionSetScreenText(before));
	const b = sections(conditionSetScreenText(after));
	const out: ConditionSetChange[] = [];
	for (const [section, lines] of b) {
		const prev = a.get(section) ?? [];
		const removed = subtract(prev, lines);
		const added = subtract(lines, prev);
		if (removed.length > 0 || added.length > 0)
			out.push({ section, removed, added });
	}
	return out;
}

/** 見出しごとの行。見出しの「（組み合わせ方: …）」は行として扱い、番号は外す */
function sections(lines: string[]): Map<string, string[]> {
	const out = new Map<string, string[]>();
	let cur: string[] = [];
	for (const line of lines) {
		const h = /^### (.+?)(?:（(組み合わせ方: .+)）)?$/.exec(line);
		if (h) {
			cur = h[2] ? [h[2]] : [];
			out.set(h[1] as string, cur);
		} else {
			cur.push(line.replace(/^(\d+\.|-) /, ""));
		}
	}
	return out;
}

/** xs から ys にある行を1つずつ除く（同じ条件が2つあるときも数を合わせる） */
function subtract(xs: string[], ys: string[]): string[] {
	const rest = [...ys];
	return xs.filter((x) => {
		const i = rest.indexOf(x);
		if (i < 0) return true;
		rest.splice(i, 1);
		return false;
	});
}
