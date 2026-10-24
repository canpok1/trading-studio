// 口座を開く先（取引所・証券会社）。手数料率は市場ではなく、ここの決まりとして持つ

import type { Market } from "./instrument";
import { COINCHECK } from "./instrument";
import type { FeeRates } from "./trading";

export type Broker = {
	id: string;
	name: string;
	/** 売買できる市場の id */
	marketIds: readonly string[];
	/** 既定の手数料率 */
	fees: FeeRates;
};

/** Coincheck の取引所。BTC/JPY は指値・成行ともに 0%（https://coincheck.com/ja/exchange/fee） */
export const COINCHECK_EXCHANGE: Broker = {
	id: "coincheck",
	name: "Coincheck",
	marketIds: [COINCHECK.id],
	fees: { limitPpm: 0, marketPpm: 0 },
};

export const BROKERS: readonly Broker[] = [COINCHECK_EXCHANGE];

/** 市場を売買できる口座の先。今は市場ごとに1つだけなので先頭を返す。定義が無ければ例外にする */
export function brokerOf(market: Market): Broker {
	const b = BROKERS.find((x) => x.marketIds.includes(market.id));
	if (!b) throw new RangeError(`口座の先が無い市場: ${market.id}`);
	return b;
}
