// 足の加工：粗い粒度の足を作る、欠損を探す

import type { Timeframe } from "./timeframe";
import { candleStart, TIMEFRAME_MS } from "./timeframe";
import type { Candle } from "./types";

/**
 * 細かい足（古い順）から粗い粒度の足を作る。足の一部が欠けていても、ある分だけで作る
 * （欠損は元の粒度の欠損として別に示す）
 */
export function aggregateCandles(
	candles: readonly Candle[],
	to: Timeframe,
): Candle[] {
	const out: Candle[] = [];
	let cur: Candle | null = null;
	for (const c of candles) {
		const start = candleStart(c.time, to);
		if (cur && cur.time === start) {
			cur.high = Math.max(cur.high, c.high);
			cur.low = Math.min(cur.low, c.low);
			cur.close = c.close;
			cur.volume += c.volume;
		} else {
			cur = { ...c, time: start };
			out.push(cur);
		}
	}
	return out;
}

export type Gap = {
	/** 最初に欠けている足の開始時刻 */
	from: number;
	/** 欠損の後の最初の足の開始時刻（この時刻は含まない） */
	to: number;
	/** 欠けている本数 */
	missing: number;
};

/** 足の開始時刻（古い順）から欠損の区間を探す。最初と最後の足の間だけを見る */
export function findGaps(
	times: readonly number[],
	timeframe: Timeframe,
): Gap[] {
	const step = TIMEFRAME_MS[timeframe];
	const gaps: Gap[] = [];
	for (let i = 1; i < times.length; i++) {
		const prev = times[i - 1] as number;
		const cur = times[i] as number;
		if (cur - prev > step) {
			gaps.push({
				from: prev + step,
				to: cur,
				missing: (cur - prev) / step - 1,
			});
		}
	}
	return gaps;
}

/** 期間 [from, to) に含まれる欠損（端で切り詰める） */
export function gapsWithin(
	gaps: readonly Gap[],
	from: number,
	to: number,
	timeframe: Timeframe,
): Gap[] {
	const step = TIMEFRAME_MS[timeframe];
	return gaps
		.filter((g) => g.to > from && g.from < to)
		.map((g) => {
			const f = Math.max(g.from, from);
			const t = Math.min(g.to, to);
			return { from: f, to: t, missing: Math.ceil((t - f) / step) };
		});
}
