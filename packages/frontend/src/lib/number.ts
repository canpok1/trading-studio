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
