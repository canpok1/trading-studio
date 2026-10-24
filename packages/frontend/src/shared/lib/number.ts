import type { Currency } from "@trading-studio/core";
import { formatAmount } from "@trading-studio/core";

/** 3桁区切り。例: 1234567 → "1,234,567" */
export function formatInt(n: number): string {
	return Math.round(n).toLocaleString("ja-JP");
}

/** 符号付きの %（小数1桁）。例: 1.234 → "+1.2%"、-0.5 → "−0.5%" */
export function formatSignedPercent(p: number): string {
	return `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(1)}%`;
}

/** 符号付きの円。例: 1234 → "+1,234" */
export function formatSignedInt(n: number): string {
	return `${n >= 0 ? "+" : "−"}${formatInt(Math.abs(n))}`;
}

/** 保有期間。1日以上なら日、未満なら時間（小数1桁） */
export function holdingText(ms: number): string {
	const h = ms / 3_600_000;
	return h >= 24 ? `${(h / 24).toFixed(1)}日` : `${h.toFixed(1)}時間`;
}

/** 符号付きの金額（単位なし）。通貨の桁まで出す。例: 円の 1234 → "+1,234" */
export function formatSignedAmount(currency: Currency, n: number): string {
	return `${n >= 0 ? "+" : "−"}${formatAmount(currency, Math.abs(n))}`;
}
