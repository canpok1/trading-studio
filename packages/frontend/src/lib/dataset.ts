import type { Dataset } from "@trading-studio/backend";
import type { MarketRegime } from "@trading-studio/core";
import { MARKET_REGIME_LABELS } from "@trading-studio/core";
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
