// 足の粒度と、足の開始時刻の求め方

import type { TradingCalendar } from "./trading-calendar";

export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const TIMEFRAME_MS: Record<Timeframe, number> = {
	"1m": MINUTE,
	"5m": 5 * MINUTE,
	"15m": 15 * MINUTE,
	"1h": HOUR,
	"4h": 4 * HOUR,
	"1d": 24 * HOUR,
};

export const TIMEFRAME_LABELS: Record<Timeframe, string> = {
	"1m": "1分足",
	"5m": "5分足",
	"15m": "15分足",
	"1h": "1時間足",
	"4h": "4時間足",
	"1d": "日足",
};

/** 画面の時刻の表示に使う JST のずれ */
export const JST_OFFSET_MS = 9 * HOUR;

export function isTimeframe(value: unknown): value is Timeframe {
	return (TIMEFRAMES as readonly unknown[]).includes(value);
}

/**
 * 時刻を含む足の開始時刻。日足は市場の日の区切り、それより細かい足は立会の始まりから数える
 * （取引時間外の時刻は日の区切りから数える）
 */
export function candleStart(
	time: number,
	timeframe: Timeframe,
	calendar: TradingCalendar,
): number {
	const day = calendar.dayStart(time);
	if (timeframe === "1d") return day;
	const { open } = calendar.session(time);
	const base = open <= time ? open : day;
	const ms = TIMEFRAME_MS[timeframe];
	return base + Math.floor((time - base) / ms) * ms;
}

/** 時刻を含む分の開始時刻。分の区切りはどの市場でも同じ */
export function minuteStart(time: number): number {
	return Math.floor(time / MINUTE) * MINUTE;
}

/** a が b より粗い（1本が長い）か */
export function isCoarser(a: Timeframe, b: Timeframe): boolean {
	return TIMEFRAME_MS[a] > TIMEFRAME_MS[b];
}

/** 指定より粗い粒度の一覧（細かい順） */
export function coarserTimeframes(timeframe: Timeframe): Timeframe[] {
	return TIMEFRAMES.filter((t) => isCoarser(t, timeframe));
}
