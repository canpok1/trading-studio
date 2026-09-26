// テスト用。メモリ上の DB で本物のサービスをつないだ app を作る
import type { AppDeps } from "./app";
import { createApp } from "./app";
import type { Db } from "./db/open";
import { createTestDb } from "./db/test-db";
import { MarketDataRepository } from "./market-data/repository";
import { createMarketDataService } from "./market-data/service";

export function createTestApp(
	over: Partial<AppDeps> = {},
	db: Db = createTestDb(),
) {
	const marketDataRepo = new MarketDataRepository(db);
	const marketData = createMarketDataService(marketDataRepo, {
		now: () => 1_000,
	});
	const app = createApp({ isDbReachable: () => true, marketData, ...over });
	return { app, db, marketData, marketDataRepo };
}
