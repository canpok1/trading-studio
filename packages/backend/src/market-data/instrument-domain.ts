// 自動取引で売買する銘柄（#280 までは BTC/JPY だけ）と、価格を収集する銘柄
import { BTC_JPY, COLLECTED_INSTRUMENTS } from "@trading-studio/core";

export const DEFAULT_INSTRUMENT = BTC_JPY;

/** 価格を収集する銘柄 */
export const COLLECTED = COLLECTED_INSTRUMENTS;
