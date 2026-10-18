// DVOL（Deribit の BTC オプションから計算した30日の予想ボラ、年率 %）の1時間足を条件で読む

import { HOUR_MS, jstDateTime } from "./event-calendar";

/** DVOL の1時間足。close は年率 % の ×100 の整数（55.23 → 5523） */
export type DvolPoint = { time: number; close: number };

/**
 * 最新の確定した足の終わりがこれより古ければ、取得が止まっているとみなす。
 * 1時間ごとの取得で、取得の時点で終わっていた足だけを使うと、取得が動いていても最大で約2時間古いため、余裕を足す
 */
export const DVOL_STALE_MS = 3 * HOUR_MS;

/** 平均を出すのに、期間の足の数のうちこの割合が要る（取得の抜けを少しだけ許す） */
export const DVOL_AVERAGE_COVERAGE = 0.9;

/** DVOL の見せ方。小数2桁 */
export const formatDvol = (v: number) => (v / 100).toFixed(2);

/** 開始が t 以上の最初の足の位置（points は古い順） */
function lowerBound(points: readonly DvolPoint[], t: number): number {
	let lo = 0;
	let hi = points.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if ((points[mid] as DvolPoint).time < t) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** now の時点で確定している最後の足。無ければ null */
export function latestDvol(
	points: readonly DvolPoint[],
	now: number,
): DvolPoint | null {
	const i = lowerBound(points, now - HOUR_MS + 1);
	return i > 0 ? (points[i - 1] as DvolPoint) : null;
}

export type DvolNow =
	| { ok: true; value: number }
	| { ok: false; reason: string };

/** now の時点の DVOL。取得が止まっていれば理由 */
export function dvolAt(points: readonly DvolPoint[], now: number): DvolNow {
	const last = latestDvol(points, now);
	if (last === null) return { ok: false, reason: "DVOL が無い" };
	if (now - (last.time + HOUR_MS) > DVOL_STALE_MS) {
		return {
			ok: false,
			reason: `DVOL の取得が止まっている（最新は ${jstDateTime(last.time)} の足）`,
		};
	}
	return { ok: true, value: last.close };
}

/** 最新の値の、平均に対する %（四捨五入しない） */
export const dvolRatioPercent = (value: number, average: number) =>
	(value / average) * 100;

/** now の時点で確定している直近 days 日の足の平均（×100）。足が足りなければ理由 */
export function dvolAverage(
	points: readonly DvolPoint[],
	now: number,
	days: number,
): DvolNow {
	const span = days * 24 * HOUR_MS;
	const from = lowerBound(points, now - span - HOUR_MS + 1);
	const to = lowerBound(points, now - HOUR_MS + 1);
	const n = to - from;
	const need = Math.ceil(days * 24 * DVOL_AVERAGE_COVERAGE);
	if (n < need) {
		return {
			ok: false,
			reason: `DVOL の ${days} 日平均に ${need} 本必要、現在 ${n} 本`,
		};
	}
	let sum = 0;
	for (let i = from; i < to; i++) sum += (points[i] as DvolPoint).close;
	return { ok: true, value: sum / n };
}
