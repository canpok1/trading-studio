import { Hono } from "hono";
import type { BacktestService } from "./backtests/types";
import type { MarketDataService } from "./market-data/types";
import { backtestRoutes } from "./routes/backtests";
import { marketDataRoutes } from "./routes/market-data";
import { strategyRoutes } from "./routes/strategies";
import type { StrategyService } from "./strategies/types";

export type AppDeps = {
	isDbReachable: () => boolean;
	marketData: MarketDataService;
	strategies: StrategyService;
	backtests: BacktestService;
};

// frontend は Hono RPC でこの型を使う。Bun 固有の API はここに持ち込まない（frontend の型チェックに Bun の型を入れないため）
export function createApp({
	isDbReachable,
	marketData,
	strategies,
	backtests,
}: AppDeps) {
	const api = new Hono()
		.get("/health", (c) =>
			c.json({
				status: "ok" as const,
				db: isDbReachable() ? ("ok" as const) : ("error" as const),
			}),
		)
		.route("/data", marketDataRoutes(marketData))
		.route("/strategies", strategyRoutes(strategies))
		.route("/backtests", backtestRoutes(backtests));
	return new Hono().route("/api", api);
}

export type AppType = ReturnType<typeof createApp>;
