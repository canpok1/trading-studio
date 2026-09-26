// テスト用。メモリ上の DB で本物のサービスをつないだ app を作る
import type { AppDeps } from "./app";
import { createApp } from "./app";
import { inlineRunner } from "./backtests/inline-runner";
import { BacktestRepository } from "./backtests/repository";
import type { BacktestRunner } from "./backtests/runner";
import { createBacktestService } from "./backtests/service";
import type { Collector } from "./collector/collector";
import type { LiveMarket } from "./collector/types";
import type { Db } from "./db/open";
import { createTestDb } from "./db/test-db";
import { createMarketService } from "./market/service";
import { MarketDataRepository } from "./market-data/repository";
import { createMarketDataService } from "./market-data/service";
import { NewsRepository } from "./news/repository";
import { createNewsService } from "./news/service";
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
	// 収集は動かさず、テストから live を差し替える
	const live: { current: LiveMarket } = {
		current: {
			latestTrade: null,
			forming: null,
			status: {
				state: "running",
				stoppedSince: null,
				error: null,
				retryAt: null,
				lastReceivedAt: null,
			},
		},
	};
	const collector: Pick<Collector, "live"> = { live: () => live.current };
	const clock = { now: 4_000 };
	const market = createMarketService({
		collector,
		repo: marketDataRepo,
		now: () => clock.now,
	});
	const backtestRepo = new BacktestRepository(db);
	const backtests = createBacktestService({
		repo: backtestRepo,
		marketData: marketDataRepo,
		strategies,
		runner,
		now: () => 3_000,
	});
	// 収集は動かさず、テストから newsRepo に書き込む
	const newsRepo = new NewsRepository(db);
	const newsRun = {
		lastRunAt: null as number | null,
		nextRunAt: null as number | null,
	};
	const news = createNewsService({
		repo: newsRepo,
		collector: {
			lastRunAt: () => newsRun.lastRunAt,
			nextRunAt: () => newsRun.nextRunAt,
		},
		now: () => 5_000,
	});
	const app = createApp({
		isDbReachable: () => true,
		marketData,
		market,
		strategies,
		backtests,
		news,
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
		live,
		clock,
		news,
		newsRepo,
		newsRun,
	};
}
