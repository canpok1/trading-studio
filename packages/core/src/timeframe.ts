// 足の粒度と、足の開始時刻の求め方

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

/** 足の区切りの起点。日足・4時間足は JST 0:00 から数える（画面の表示と揃える） */
export const JST_OFFSET_MS = 9 * HOUR;

export function isTimeframe(value: unknown): value is Timeframe {
	return (TIMEFRAMES as readonly unknown[]).includes(value);
}

/** 時刻を含む足の開始時刻 */
export function candleStart(time: number, timeframe: Timeframe): number {
	const ms = TIMEFRAME_MS[timeframe];
	return Math.floor((time + JST_OFFSET_MS) / ms) * ms - JST_OFFSET_MS;
}

/** a が b より粗い（1本が長い）か */
export function isCoarser(a: Timeframe, b: Timeframe): boolean {
	return TIMEFRAME_MS[a] > TIMEFRAME_MS[b];
}

/** 指定より粗い粒度の一覧（細かい順） */
export function coarserTimeframes(timeframe: Timeframe): Timeframe[] {
	return TIMEFRAMES.filter((t) => isCoarser(t, timeframe));
}
