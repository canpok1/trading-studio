// 偽物の API が返す値のひな形。テストで変えたいところだけ上書きする
import type { AutoTradingStatus } from "@trading-studio/backend";
import type { InferResponseType } from "hono/client";
import type { ApiClient } from "../src/shared/lib/api";

export function tradingRun(
	over: Partial<AutoTradingStatus> & Pick<AutoTradingStatus, "id" | "name">,
): AutoTradingStatus {
	return {
		enabled: false,
		mode: "paper",
		strategy: null,
		nextEvalAt: null,
		startedAt: null,
		waitingForMarket: false,
		dailyLoss: { loss: 0, limit: null, blocked: false },
		account: {
			initialCash: 1_000_000,
			cash: 1_000_000,
			position: { quantity: 0, entryPrice: null, openedAt: null },
			lots: [],
			openOrderCount: 0,
			resetAt: 0,
			equity: 1_000_000,
		},
		strategyLock: null,
		...over,
	};
}

type MarketLatest = InferResponseType<
	ApiClient["api"]["market"]["latest"]["$get"]
>;

/** 価格の収集が動いていて、価格がまだ無い状態 */
export function marketLatest(over: Partial<MarketLatest> = {}): MarketLatest {
	return {
		price: null,
		priceTime: null,
		price24hAgo: null,
		forming: null,
		collector: {
			state: "running",
			stoppedSince: null,
			error: null,
			retryAt: null,
			lastReceivedAt: null,
		},
		...over,
	};
}
