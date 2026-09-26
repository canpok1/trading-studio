import { Hono } from "hono";
import type { MarketDataService } from "./market-data/types";
import { marketDataRoutes } from "./routes/market-data";

export type AppDeps = {
	isDbReachable: () => boolean;
	marketData: MarketDataService;
};

// frontend は Hono RPC でこの型を使う。Bun 固有の API はここに持ち込まない（frontend の型チェックに Bun の型を入れないため）
export function createApp({ isDbReachable, marketData }: AppDeps) {
	const api = new Hono()
		.get("/health", (c) =>
			c.json({
				status: "ok" as const,
				db: isDbReachable() ? ("ok" as const) : ("error" as const),
			}),
		)
		.route("/data", marketDataRoutes(marketData));
	return new Hono().route("/api", api);
}

export type AppType = ReturnType<typeof createApp>;
