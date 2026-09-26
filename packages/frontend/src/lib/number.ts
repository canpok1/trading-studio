/** 3桁区切り。例: 1234567 → "1,234,567" */
export function formatInt(n: number): string {
	return Math.round(n).toLocaleString("ja-JP");
}
