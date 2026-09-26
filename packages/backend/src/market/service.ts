// 最新価格とホームのチャートの足

import { candleStart, TIMEFRAME_MS } from "@trading-studio/core";
import type { Collector } from "../collector/collector";
import type { MarketDataRepository } from "../market-data/repository";
import type { ChartRangeId, MarketService } from "./types";

/** チャートに一度に返す足の上限。これより多い組み合わせは選べなくする */
export const MAX_CHART_BARS = 50_000;

const DAY = TIMEFRAME_MS["1d"];
export const CHART_RANGE_MS: Record<Exclude<ChartRangeId, "all">, number> = {
	"1d": DAY,
	"1w": 7 * DAY,
	"1m": 30 * DAY,
};

export function createMarketService({
	collector,
	repo,
	now = Date.now,
}: {
	collector: Pick<Collector, "live">;
	repo: MarketDataRepository;
	now?: () => number;
}): MarketService {
	return {
		latest() {
			const live = collector.live();
			const t = now();
			const last = repo.lastCandle("1m");
			const price =
				live.latestTrade?.price ?? live.forming?.close ?? last?.close ?? null;
			const priceTime =
				live.latestTrade?.time ??
				(last ? last.time + TIMEFRAME_MS["1m"] : null);
			return {
				price,
				priceTime: price === null ? null : priceTime,
				price24hAgo: repo.lastCandleAtOrBefore("1m", t - DAY)?.close ?? null,
				forming: live.forming,
				collector: live.status,
			};
		},

		bars(timeframe, range, history) {
			const t = now();
			const to = t + TIMEFRAME_MS[timeframe];
			// 期間の始まりの時刻を含む足から返す（日足で1日を選んでも当日の足が入るように）
			const from =
				range === "all"
					? Number.MIN_SAFE_INTEGER
					: candleStart(t - CHART_RANGE_MS[range], timeframe);
			const count = repo.countCandles(timeframe, from, to);
			if (count > MAX_CHART_BARS) {
				return { ok: false, kind: "too_many", count, max: MAX_CHART_BARS };
			}
			const before =
				history > 0 && range !== "all"
					? repo.candlesBefore(timeframe, from, history)
					: [];
			const bars = [...before, ...repo.loadCandles(timeframe, from, to)].map(
				(c) => ({
					time: c.time,
					open: c.open,
					high: c.high,
					low: c.low,
					close: c.close,
				}),
			);
			return { ok: true, bars };
		},
	};
}
