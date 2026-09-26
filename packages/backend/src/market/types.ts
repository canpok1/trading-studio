// 最新価格とホームのチャートの API が使う型。app.ts から参照されるため、Bun 固有の型を持ち込まない

import type { Candle, Timeframe } from "@trading-studio/core";
import type { CollectorStatus } from "../collector/types";

export type ChartRangeId = "1d" | "1w" | "1m" | "all";

export type LatestMarket = {
	/** 現在値（直近の約定の価格。まだ約定を受けていなければ最後に保存した1分足の終値）。データが無ければ null */
	price: number | null;
	/** 現在値の時刻 */
	priceTime: number | null;
	/** 24時間前の1分足の終値。無ければ null */
	price24hAgo: number | null;
	/** 形成中の1分足 */
	forming: Candle | null;
	collector: CollectorStatus;
};

export type MarketBarsResult =
	| { ok: true; bars: { time: number; close: number }[] }
	| { ok: false; kind: "too_many"; count: number; max: number };

export interface MarketService {
	latest(): LatestMarket;
	/** 粒度と期間を指定した足。history は期間の前に足す本数（EMA の計算に使う） */
	bars(
		timeframe: Timeframe,
		range: ChartRangeId,
		history: number,
	): MarketBarsResult;
}
