// 収集・売買する銘柄。戦略ごとに銘柄を持つまで（#262）は BTC/JPY だけを扱う
import { BTC_JPY, COLLECTED_INSTRUMENTS } from "@trading-studio/core";

export const DEFAULT_INSTRUMENT = BTC_JPY;

/** 価格を収集する銘柄 */
export const COLLECTED = COLLECTED_INSTRUMENTS;
