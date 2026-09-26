// テスト用。メモリ上の DB で本物のサービスをつないだ app を作る
import type { AppDeps } from "./app";
import { createApp } from "./app";
import { inlineRunner } from "./backtests/inline-runner";
import { BacktestRepository } from "./backtests/repository";
import type { BacktestRunner } from "./backtests/runner";
import { createBacktestService } from "./backtests/service";
import type { Db } from "./db/open";
import { createTestDb } from "./db/test-db";
import { MarketDataRepository } from "./market-data/repository";
import { createMarketDataService } from "./market-data/service";
import { createStrategyService } from "./strategies/service";

export function createTestApp(
	over: Partial<AppDeps> = {},
	db: Db = createTestDb(),
	runner: BacktestRunner = inlineRunner(),
) {
	const marketDataRepo = new MarketDataRepository(db);
	const marketData = createMarketDataService(marketDataRepo, {
		now: () => 1_000,
	});
	const strategies = createStrategyService(db, () => 2_000);
	const backtestRepo = new BacktestRepository(db);
	const backtests = createBacktestService({
		repo: backtestRepo,
		marketData: marketDataRepo,
		strategies,
		runner,
		now: () => 3_000,
	});
	const app = createApp({
		isDbReachable: () => true,
		marketData,
		strategies,
		backtests,
		...over,
	});
	return {
		app,
		db,
		marketData,
		marketDataRepo,
		strategies,
		backtests,
		backtestRepo,
	};
}
