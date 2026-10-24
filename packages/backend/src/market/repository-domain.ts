// 最新価格とチャートの足が読む、保存済みの足と収集中の価格。実装は相場データのリポジトリと価格の収集

import type { Candle, Instrument, Timeframe } from "@trading-studio/core";
import type { LiveMarket } from "../collector/collector-domain";

export interface MarketRepository {
	readonly instrument: Instrument;
	/** 最後の足。無ければ null */
	lastCandle(timeframe: Timeframe): Candle | null;
	/** time 以前で最後の足。無ければ null */
	lastCandleAtOrBefore(timeframe: Timeframe, time: number): Candle | null;
	/** before より前の足を count 本（古い順） */
	candlesBefore(timeframe: Timeframe, before: number, count: number): Candle[];
	/** [from, to) の足の本数 */
	countCandles(timeframe: Timeframe, from: number, to: number): number;
	/** [from, to) の足（古い順） */
	loadCandles(timeframe: Timeframe, from: number, to: number): Candle[];
}

export interface LiveMarketSource {
	/** 収集中の価格と収集の状態 */
	live(): LiveMarket;
}
