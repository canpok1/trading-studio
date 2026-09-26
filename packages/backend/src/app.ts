import { Hono } from "hono";
import type { BacktestService } from "./backtests/types";
import type { MarketService } from "./market/types";
import type { MarketDataService } from "./market-data/types";
import type { NewsService, ScoringService } from "./news/types";
import { backtestRoutes } from "./routes/backtests";
import { marketRoutes } from "./routes/market";
import { marketDataRoutes } from "./routes/market-data";
import { newsRoutes } from "./routes/news";
import { scoringRoutes } from "./routes/scoring";
import { strategyRoutes } from "./routes/strategies";
import type { StrategyService } from "./strategies/types";

export type AppDeps = {
	isDbReachable: () => boolean;
	marketData: MarketDataService;
	market: MarketService;
	strategies: StrategyService;
	backtests: BacktestService;
	news: NewsService;
	scoring: ScoringService;
};

// frontend は Hono RPC でこの型を使う。Bun 固有の API はここに持ち込まない（frontend の型チェックに Bun の型を入れないため）
export function createApp({
	isDbReachable,
	marketData,
	market,
	strategies,
	backtests,
	news,
	scoring,
}: AppDeps) {
	const api = new Hono()
		.get("/health", (c) =>
			c.json({
				status: "ok" as const,
				db: isDbReachable() ? ("ok" as const) : ("error" as const),
			}),
		)
		.route("/data", marketDataRoutes(marketData))
		.route("/market", marketRoutes(market))
		.route("/strategies", strategyRoutes(strategies))
		.route("/backtests", backtestRoutes(backtests))
		.route("/news", newsRoutes(news))
		.route("/scoring", scoringRoutes(scoring));
	return new Hono().route("/api", api);
}

export type AppType = ReturnType<typeof createApp>;
