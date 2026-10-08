import type { Dataset } from "@trading-studio/backend";
import type { MarketRegime } from "@trading-studio/core";
import {
	MARKET_REGIME_LABELS,
	TREND_PPM,
	VOLATILE_PPM,
} from "@trading-studio/core";
import { formatDate } from "../format";

/** 期間の月。例: 2026/08〜09、年をまたげば 2025/12〜2026/01 */
export function datasetMonths(d: Pick<Dataset, "from" | "to">): string {
	const a = formatDate(d.from).slice(0, 7);
	const b = formatDate(d.to - 1).slice(0, 7);
	return a.slice(0, 4) === b.slice(0, 4) ? `${a}〜${b.slice(5)}` : `${a}〜${b}`;
}

/** 例: 2026/08〜09 上昇相場 */
export function datasetName(
	d: Pick<Dataset, "from" | "to"> & { regime: MarketRegime },
): string {
	return `${datasetMonths(d)} ${MARKET_REGIME_LABELS[d.regime]}`;
}

/** ppm を符号付きの % で。例: +32.7% */
export function signedPercent(ppm: number): string {
	const v = (ppm / 10_000).toFixed(1);
	return ppm > 0 ? `+${v}%` : `${v}%`;
}

/** 期間・騰落率・日ごとの値動き。例: 2026/08/01〜2026/09/30 · 騰落率 +32.7% · 日ごとの値動き 2.1% */
export function datasetSummary(d: Dataset): string {
	return `${formatDate(d.from)}〜${formatDate(d.to - 1)} · 騰落率 ${signedPercent(d.returnPpm)} · 日ごとの値動き ${(d.volatilityPpm / 10_000).toFixed(1)}%`;
}

/** 相場の分け方の説明 */
export const REGIME_RULE_TEXT = `乱高下は日ごとの値動き（終値の変化）のばらつきが${VOLATILE_PPM / 10_000}%以上。それ以外は期間の騰落率が+${TREND_PPM / 10_000}%以上で上昇、−${TREND_PPM / 10_000}%以下で下落、その間はレンジ。`;
