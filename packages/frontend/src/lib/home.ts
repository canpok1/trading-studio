// ホームの表示の計算。描画に依存しない部分をここに置き、単体テストする

import type { CollectorStatus } from "@trading-studio/backend";
import type { Timeframe } from "@trading-studio/core";
import { candleStart, TIMEFRAME_MS, TIMEFRAMES } from "@trading-studio/core";
import type { ChartBar, ChartRange } from "../components/chart/chart-data";
import { formatDateTime } from "../format";

/** チャートに一度に出す足の上限（サーバーと同じ値） */
export const MAX_CHART_BARS = 50_000;

const RANGE_MS: Record<Exclude<ChartRange, "all">, number> = {
	"1d": TIMEFRAME_MS["1d"],
	"1w": 7 * TIMEFRAME_MS["1d"],
	"1m": 30 * TIMEFRAME_MS["1d"],
};

/** 戦略が無いときの、期間に合わせた粒度 */
export const RANGE_DEFAULT_TIMEFRAME: Record<ChartRange, Timeframe> = {
	"1d": "1m",
	"1w": "15m",
	"1m": "1h",
	all: "1d",
};

/**
 * 期間と粒度の組み合わせの足の数（多めに見積もる）。全期間は保存済みの足の数。
 * counts に無い粒度は 0 本とみなす
 */
export function barCount(
	range: ChartRange,
	timeframe: Timeframe,
	counts: Partial<Record<Timeframe, number>>,
): number {
	if (range === "all") return counts[timeframe] ?? 0;
	return Math.ceil(RANGE_MS[range] / TIMEFRAME_MS[timeframe]) + 1;
}

/** 足が多すぎて選べない粒度 */
export function tooManyTimeframes(
	range: ChartRange,
	counts: Partial<Record<Timeframe, number>>,
): Timeframe[] {
	return TIMEFRAMES.filter((t) => barCount(range, t, counts) > MAX_CHART_BARS);
}

/** 希望の粒度が選べなければ、選べる中で最も近い粗い粒度にする */
export function usableTimeframe(
	wanted: Timeframe,
	disabled: readonly Timeframe[],
): Timeframe {
	const from = TIMEFRAMES.indexOf(wanted);
	return TIMEFRAMES.slice(from).find((t) => !disabled.includes(t)) ?? "1d";
}

/**
 * 取得済みの足に最新の価格を反映する。最新の価格の時刻を含む足があればその終値を置き換え、
 * 無ければ足を1本足す
 */
export function withLatestPrice(
	bars: readonly ChartBar[],
	timeframe: Timeframe,
	price: number | null,
	time: number | null,
): ChartBar[] {
	if (price === null || time === null) return [...bars];
	const start = candleStart(time, timeframe);
	const last = bars.at(-1);
	if (last && last.time > start) return [...bars];
	if (last && last.time === start) {
		return [...bars.slice(0, -1), withPrice(last, price)];
	}
	return [
		...bars,
		{ time: start, open: price, high: price, low: price, close: price },
	];
}

/** 足の終値を置き換える。4本値があれば高値・安値も広げる */
function withPrice(bar: ChartBar, price: number): ChartBar {
	if (bar.high === undefined || bar.low === undefined) {
		return { ...bar, close: price };
	}
	return {
		...bar,
		high: Math.max(bar.high, price),
		low: Math.min(bar.low, price),
		close: price,
	};
}

/** 24時間の変化率（%）。基準が無ければ null */
export function changePercent(
	price: number | null,
	base: number | null,
): number | null {
	if (price === null || base === null || base === 0) return null;
	return (price / base - 1) * 100;
}

/** 収集が止まっているときに出す文言。止まっていなければ null */
export function collectorTrouble(
	s: CollectorStatus,
): { what: string; since: string; retry: string } | null {
	if (s.state !== "stopped") return null;
	return {
		what: s.error ?? "価格の収集が止まっている",
		since: s.stoppedSince === null ? "—" : formatDateTime(s.stoppedSince),
		retry:
			s.retryAt === null
				? "再接続の予定なし"
				: `自動で再接続中（次は ${formatDateTime(s.retryAt).slice(11)}）`,
	};
}
