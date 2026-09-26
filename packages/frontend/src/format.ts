// 画面の日時表示。時刻は UTC のエポックミリ秒で持ち、表示時に JST へ変換する

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const p2 = (n: number) => String(n).padStart(2, "0");

function jstParts(ms: number) {
	const d = new Date(ms + JST_OFFSET_MS);
	return {
		y: d.getUTCFullYear(),
		mo: d.getUTCMonth() + 1,
		d: d.getUTCDate(),
		h: d.getUTCHours(),
		mi: d.getUTCMinutes(),
		s: d.getUTCSeconds(),
	};
}

/** 例: 2026/09/26 13:14:15 */
export function formatDateTime(ms: number): string {
	const t = jstParts(ms);
	return `${t.y}/${p2(t.mo)}/${p2(t.d)} ${p2(t.h)}:${p2(t.mi)}:${p2(t.s)}`;
}

/** 例: 13:14。now と日（JST）が違えば 9/27 13:14 */
export function formatClock(ms: number, now: number): string {
	const t = jstParts(ms);
	const n = jstParts(now);
	const hm = `${p2(t.h)}:${p2(t.mi)}`;
	return t.y === n.y && t.mo === n.mo && t.d === n.d
		? hm
		: `${t.mo}/${t.d} ${hm}`;
}

/** 例: 2026/09/26 */
export function formatDate(ms: number): string {
	const t = jstParts(ms);
	return `${t.y}/${p2(t.mo)}/${p2(t.d)}`;
}

/** 例: 2026/09/26（土） */
export function formatDateWeekday(ms: number): string {
	const w = "日月火水木金土"[new Date(ms + JST_OFFSET_MS).getUTCDay()];
	return `${formatDate(ms)}（${w}）`;
}

/** 例: 2026-09-26（input type="date" の値） */
export function toDateInputValue(ms: number): string {
	const t = jstParts(ms);
	return `${t.y}-${p2(t.mo)}-${p2(t.d)}`;
}

/** input type="date" の値（JST の日付）をその日の 0:00 のエポックミリ秒へ */
export function fromDateInputValue(value: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!m) return null;
	return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - JST_OFFSET_MS;
}
