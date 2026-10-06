// テスト用。メモリ上の DB で本物のサービスをつないだ app を作る
import { demoAdviceModel } from "./advice/fake-model";
import { DEFAULT_INSTRUCTIONS } from "./advice/prompt";
import { AdviceRepository } from "./advice/repository";
import { createAdviceService } from "./advice/service";
import { AnalysisExportRepository } from "./analysis-export/repository";
import { createAnalysisExportService } from "./analysis-export/service";
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
import { createJudgmentService } from "./judgments/service";
import { createMarketService } from "./market/service";
import { MarketDataRepository } from "./market-data/repository";
import { createMarketDataService } from "./market-data/service";
import { demoScoreModel } from "./news/fake-model";
import type { GeminiModel } from "./news/gemini";
import { DEFAULT_CRITERIA } from "./news/prompt";
import { NewsRepository } from "./news/repository";
import { ScoreRepository } from "./news/score-repository";
import { createScorer } from "./news/scorer";
import { createScoringService } from "./news/scoring-service";
import { createNewsService } from "./news/service";
import { RetentionRepository } from "./retention/repository";
import { createRetentionService } from "./retention/service";
import { ScoringAnalysisRepository } from "./scoring-analysis/repository";
import { createScoringAnalysis } from "./scoring-analysis/service";
import { createStrategyService } from "./strategies/service";
import { TradingRepository } from "./trading/repository";
import { createTradingService } from "./trading/service";

/** テストの手数料率。既定は 0% だが、手数料の扱いを確かめるため 0.1% で動かす */
export const TEST_FEE_RATES = { limitPpm: 1000, marketPpm: 1000 };

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
			unsaved: [],
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
	// 収集は動かさず、テストから newsRepo に書き込む
	const newsRepo = new NewsRepository(db);
	const newsRun = {
		lastRunAt: null as number | null,
		nextRunAt: null as number | null,
	};
	const scoreRepo = new ScoreRepository(db);
	const news = createNewsService({
		repo: newsRepo,
		rule: () => scoreRepo.aggregationRule(),
		collector: {
			lastRunAt: () => newsRun.lastRunAt,
			nextRunAt: () => newsRun.nextRunAt,
		},
		now: () => 5_000,
	});
	scoreRepo.seedCriteria(DEFAULT_CRITERIA, 0);
	// 採点は自動では動かさず、テストから scorer.tick() を呼ぶ
	const scorer = createScorer({
		repo: scoreRepo,
		model: demoScoreModel(),
		rule: () => scoreRepo.aggregationRule(),
		now: () => clock.now,
		minIntervalMs: 0,
	});
	const scoring = createScoringService({
		repo: scoreRepo,
		newsRepo,
		scorer,
		now: () => clock.now,
	});
	const judgments = createJudgmentService({
		repo: scoreRepo,
		now: () => clock.now,
	});
	const backtestRepo = new BacktestRepository(db);
	const backtests = createBacktestService({
		repo: backtestRepo,
		marketData: marketDataRepo,
		strategies,
		runner,
		judgments,
		scoring,
		now: () => 3_000,
	});
	const adviceRepo = new AdviceRepository(db);
	adviceRepo.seedInstructions(DEFAULT_INSTRUCTIONS, 0);
	// テストから偽物の AI を差し替える
	const adviceAi: { model: GeminiModel } = { model: demoAdviceModel() };
	const advice = createAdviceService({
		repo: adviceRepo,
		backtests,
		backtestRepo,
		model: {
			unavailable: () => adviceAi.model.unavailable(),
			generate: (...a) => adviceAi.model.generate(...a),
		},
		appBuiltAt: null,
		now: () => clock.now,
	});
	// 常駐処理は動かさず、テストから trading.tick() と trading.onTrades() を呼ぶ
	const tradingRepo = new TradingRepository(db);
	const trading = createTradingService({
		repo: tradingRepo,
		strategies,
		judgments,
		marketData: marketDataRepo,
		market: () => live.current,
		now: () => clock.now,
		fees: TEST_FEE_RATES,
	});
	const analysisExport = createAnalysisExportService({
		repo: new AnalysisExportRepository(db),
		scoreRepo,
		backtestRepo,
		marketData,
		now: () => clock.now,
	});
	// 定期の削除は動かさず、テストから retention.tick() を呼ぶ
	const retention = createRetentionService({
		repo: new RetentionRepository(db),
		now: () => clock.now,
	});
	const scoringAnalysis = createScoringAnalysis({
		repo: new ScoringAnalysisRepository(db),
		marketData,
		judgments,
		scorer,
		now: () => clock.now,
	});
	const app = createApp({
		isDbReachable: () => true,
		appBuiltAt: null,
		marketData,
		market,
		strategies,
		backtests,
		advice,
		news,
		scoring,
		judgments,
		trading,
		analysisExport,
		retention,
		accuracy: scoringAnalysis,
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
		advice,
		adviceRepo,
		adviceAi,
		live,
		clock,
		news,
		newsRepo,
		newsRun,
		scoreRepo,
		scorer,
		scoring,
		judgments,
		scoringAnalysis,
		trading,
		tradingRepo,
		retention,
	};
}
