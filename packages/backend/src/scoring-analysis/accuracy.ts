// 市場評価の精度。記事ごとに、点数の段階とその後の値動きの段階を突き合わせる（docs/news-page.md）

import type { AggregationRule, Scores } from "@trading-studio/core";
import { classify as judgmentOf } from "@trading-studio/core";
import type { RiskBands, SentimentBands } from "./types";

/** 値動きの5段階。-2 が大きく下落、2 が大きく上昇 */
export function moveLevel(pct: number, b: SentimentBands): number {
	const a = Math.abs(pct);
	const m = a < b.small ? 0 : a < b.large ? 1 : 2;
	return pct < 0 && m > 0 ? -m : m;
}

/** 値動きの大きさの5段階。0 が静か、1 がやや荒れ、2 が荒れた、3 がかなり荒れ、4 が大荒れ */
export function roughLevel(pct: number, b: RiskBands): number {
	const a = Math.abs(pct);
	return a < b.slight
		? 0
		: a < b.rough
			? 1
			: a < b.heavy
				? 2
				: a < b.wild
					? 3
					: 4;
}

/** リスクの段階を値動きの5段階に当てる。平常＝静か、やや警戒＝やや荒れ、警戒＝荒れた、かなり警戒＝かなり荒れ、危機＝大荒れ */
const RISK_LEVEL = {
	calm: 0,
	mild: 1,
	alert: 2,
	severe: 3,
	crisis: 4,
} as const;

/** 段階のずれから精度。一致で 5、1段ずれるごとに 1 下げる（5段階どうしなので 1 が最低） */
const precisionOf = (predicted: number, actual: number) =>
	5 - Math.abs(predicted - actual);

/**
 * 騰落率（%）を、観点ごとの値動きの段階の番号（0〜4）にする。
 * センチメントは 0 が大きく下落〜4 が大きく上昇、リスクは 0 が静か〜4 が大荒れ（記事の段階の番号と同じ向き）
 */
export function actualLevels(
	returnPct: number,
	bands: { sentiment: SentimentBands; risk: RiskBands },
): { sentiment: number; risk: number } {
	return {
		sentiment: moveLevel(returnPct, bands.sentiment) + 2,
		risk: roughLevel(returnPct, bands.risk),
	};
}

/** 点数と騰落率（%）から、センチメントとリスクの精度 */
export function articlePrecision(
	scores: Scores,
	returnPct: number,
	rule: AggregationRule,
	bands: { sentiment: SentimentBands; risk: RiskBands },
): { sentiment: number; risk: number } {
	return {
		sentiment: precisionOf(
			Number(judgmentOf("sentiment", scores.sentiment, rule)),
			moveLevel(returnPct, bands.sentiment),
		),
		risk: precisionOf(
			RISK_LEVEL[judgmentOf("risk", scores.risk, rule)],
			roughLevel(returnPct, bands.risk),
		),
	};
}
