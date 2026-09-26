// ホームの表示の計算。描画に依存しない部分をここに置き、単体テストする

import type { CollectorStatus } from "@trading-studio/backend";
import type { Timeframe } from "@trading-studio/core";
import { candleStart, TIMEFRAME_MS } from "@trading-studio/core";
import type { ChartBar, ChartRange } from "../components/chart/chart-data";
import { formatDateTime } from "../format";

/**
 * ホームで一度に読み込む足の上限。サーバーの上限（5万本）より小さくし、1分ごとの取り直しを軽く保つ。
 * 期間の切り替えを置かないので、粒度ごとにこの本数に収まる最も長い期間を読み込み、拡大・縮小で見る
 */
export const HOME_LOAD_BARS = 20_000;

/** 最初に見せる長さ（最新から遡る）。読み込んだ足のうちこの分を画面に収め、残りは縮小・スクロールで見る */
export const HOME_INITIAL_SPAN_MS = TIMEFRAME_MS["1d"];

/** 戦略が無いときの粒度 */
export const HOME_DEFAULT_TIMEFRAME: Timeframe = "1m";

const RANGE_MS: Record<Exclude<ChartRange, "all">, number> = {
	"1d": TIMEFRAME_MS["1d"],
	"1w": 7 * TIMEFRAME_MS["1d"],
	"1m": 30 * TIMEFRAME_MS["1d"],
};

/** 長い順。読み込む期間はこの中から選ぶ */
const LOAD_RANGES: readonly ChartRange[] = ["all", "1m", "1w", "1d"];

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

/** 粒度ごとに読み込む期間。上限の本数に収まる最も長い期間。どれも収まらなければ1日 */
export function loadRange(
	timeframe: Timeframe,
	counts: Partial<Record<Timeframe, number>>,
	max = HOME_LOAD_BARS,
): ChartRange {
	return LOAD_RANGES.find((r) => barCount(r, timeframe, counts) <= max) ?? "1d";
}

/** 判定を問い合わせる足の数の上限。サーバーの上限（10万本）より小さく、今の時刻までの分の余裕を残す */
const JUDGMENT_BARS = 50_000;

/**
 * 判定を問い合わせる期間の始まり。全期間を読むと、足の数が少なくても欠損を挟んで期間が長くなり、
 * サーバーの上限を超えて判定が出なくなる。そのときは最後の足から遡る分だけにする（足の開始時刻に揃ったまま）
 */
export function judgmentsFrom(
	first: number,
	last: number,
	timeframe: Timeframe,
): number {
	return Math.max(first, last - JUDGMENT_BARS * TIMEFRAME_MS[timeframe]);
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
