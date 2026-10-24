// テスト用。メモリ上の DB で本物のサービスをつないだ app を作る

import { BTC_JPY, COLLECTED_INSTRUMENTS, ETH_JPY } from "@trading-studio/core";
import { createAdviceService } from "../src/advice/advice-domain";
import { demoAdviceModel } from "../src/advice/fake-model-infra";
import { DEFAULT_INSTRUCTIONS } from "../src/advice/prompt-domain";
import { SqliteAdviceRepository } from "../src/advice/repository-infra";
import { createCompatibleService } from "../src/ai/ai-domain";
import { SqliteCompatibleRepository } from "../src/ai/compatible-infra";
import { demoCompatibleModels } from "../src/ai/fake-models-infra";
import type { GeminiModel } from "../src/ai/model-domain";
import { DEFAULT_SCORING_MODEL } from "../src/ai/model-domain";
import { createAnalysisExportService } from "../src/analysis-export/analysis-export-domain";
import { SqliteAnalysisExportRepository } from "../src/analysis-export/repository-infra";
import { createZip } from "../src/analysis-export/zip-infra";
import type { AppDeps } from "../src/app";
import { createApp } from "../src/app";
import { createBacktestService } from "../src/backtests/backtests-domain";
import { inlineRunner } from "../src/backtests/inline-runner-infra";
import { SqliteBacktestRepository } from "../src/backtests/repository-infra";
import type { BacktestRunner } from "../src/backtests/runner-domain";
import { createCalendarService } from "../src/calendar/calendar-domain";
import type { IcalEvent } from "../src/calendar/repository-domain";
import { SqliteCalendarRepository } from "../src/calendar/repository-infra";
import type { LiveMarket } from "../src/collector/collector-domain";
import { createDatasetService } from "../src/datasets/datasets-domain";
import { SqliteDatasetRepository } from "../src/datasets/repository-infra";
import type { Db } from "../src/db/open-infra";
import { createTestDb } from "../src/db/test-db-infra";
import type { FetchDvol } from "../src/dvol/dvol-domain";
import { createDvolService } from "../src/dvol/dvol-domain";
import { SqliteDvolRepository } from "../src/dvol/repository-infra";
import { createJudgmentService } from "../src/judgments/judgments-domain";
import { createMarketService } from "../src/market/market-domain";
import { createMarketDataService } from "../src/market-data/market-data-domain";
import { SqliteMarketDataRepository } from "../src/market-data/repository-infra";
import { newsDelayMs } from "../src/news/collector-domain";
import { demoScoreModel } from "../src/news/fake-model-infra";
import { createNewsService } from "../src/news/news-domain";
import { DEFAULT_CRITERIA } from "../src/news/prompt-domain";
import { SqliteNewsRepository } from "../src/news/repository-infra";
import { SqliteScoreRepository } from "../src/news/score-repository-infra";
import { createScorer } from "../src/news/scorer-domain";
import { createScoringService } from "../src/news/scoring-domain";
import { SqliteRetentionRepository } from "../src/retention/repository-infra";
import { createRetentionService } from "../src/retention/retention-domain";
import { SqliteScoringAnalysisRepository } from "../src/scoring-analysis/repository-infra";
import { createScoringAnalysis } from "../src/scoring-analysis/scoring-analysis-domain";
import { SqliteSegmentRepository } from "../src/segments/repository-infra";
import { createSegmentService } from "../src/segments/segments-domain";
import { SqliteStrategyRepository } from "../src/strategies/repository-infra";
import { createStrategyService } from "../src/strategies/strategies-domain";
import { SqliteTradingRepository } from "../src/trading/repository-infra";
import { createTradingService } from "../src/trading/trading-domain";

/** テストの手数料率。既定は 0% だが、手数料の扱いを確かめるため 0.1% で動かす */
export const TEST_FEE_RATES = { limitPpm: 1000, marketPpm: 1000 };

export function createTestApp(
	over: Partial<AppDeps> = {},
	db: Db = createTestDb(),
	runner: BacktestRunner = inlineRunner(),
) {
	const marketDataRepo = new SqliteMarketDataRepository(db, BTC_JPY);
	const marketData = createMarketDataService(marketDataRepo, {
		now: () => 1_000,
	});
	const otherRepos = COLLECTED_INSTRUMENTS.filter(
		(i) => i.id !== BTC_JPY.id,
	).map((i) => new SqliteMarketDataRepository(db, i));
	const collectedRepos = [marketDataRepo, ...otherRepos];
	const repoOf = (id: string) =>
		collectedRepos.find(
			(r) => r.instrument.id === id,
		) as SqliteMarketDataRepository;
	const ethMarketData = createMarketDataService(repoOf(ETH_JPY.id), {
		now: () => 1_000,
	});
	const strategies = createStrategyService(
		new SqliteStrategyRepository(db),
		() => 2_000,
	);
	// 収集は動かさず、テストから live（BTC/JPY）と liveOf(銘柄) を差し替える
	const idle = (): { current: LiveMarket } => ({
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
	});
	const live = idle();
	const lives = new Map(
		collectedRepos.map((r) => [
			r.instrument.id,
			r === marketDataRepo ? live : idle(),
		]),
	);
	const liveOf = (id: string) => lives.get(id) as { current: LiveMarket };
	const clock = { now: 4_000 };
	const marketByInstrument = collectedRepos.map((repo) =>
		createMarketService({
			collector: { live: () => liveOf(repo.instrument.id).current },
			repo,
			now: () => clock.now,
		}),
	);
	const market = marketByInstrument[0] as (typeof marketByInstrument)[number];
	// 収集は動かさず、テストから newsRepo に書き込む
	const newsRepo = new SqliteNewsRepository(db, () => clock.now);
	const newsRun = {
		lastRunAt: null as number | null,
		nextRunAt: null as number | null,
	};
	const scoreRepo = new SqliteScoreRepository(db);
	const news = createNewsService({
		repo: newsRepo,
		rule: () => scoreRepo.aggregationRule(),
		collector: {
			lastRunAt: () => newsRun.lastRunAt,
			nextRunAt: () => newsRun.nextRunAt,
		},
		rescoring: () => scorer.rescoring(),
		now: () => 5_000,
	});
	scoreRepo.seedCriteria(DEFAULT_CRITERIA, 0);
	// 取得は自動では動かさず、テストから calendar.run() を呼ぶ。取得元の中身は icalFeeds に URL ごとに入れる
	const icalFeeds = new Map<string, IcalEvent[] | Error>();
	const calendar = createCalendarService({
		repo: new SqliteCalendarRepository(db),
		fetchIcal: async (url) => {
			const v = icalFeeds.get(url);
			if (v === undefined) throw new Error("HTTP 404");
			if (v instanceof Error) throw v;
			return v;
		},
		now: () => clock.now,
	});
	// 予定の重要度の判断は、テストで eventJobs.on を立てたときだけ採点の合間に進める（ほかのテストの採点の順番を変えないため）
	const eventJobs = { on: false };
	// 採点は自動では動かさず、テストから scorer.tick() を呼ぶ
	const scorer = createScorer({
		repo: scoreRepo,
		model: demoScoreModel(),
		rule: () => scoreRepo.aggregationRule(),
		now: () => clock.now,
		minIntervalMs: 0,
		jobs: {
			urgent: (t) => (eventJobs.on ? calendar.jobs.urgent(t) : null),
			background: (t) => (eventJobs.on ? calendar.jobs.background(t) : null),
		},
	});
	const scoring = createScoringService({
		repo: scoreRepo,
		newsRepo,
		scorer,
		now: () => clock.now,
	});
	const judgments = createJudgmentService({
		repo: scoreRepo,
		newsDelayMs: () => newsDelayMs(newsRepo),
		now: () => clock.now,
	});
	// 定期の作成は動かさず、テストから segments.build() を呼ぶ
	const segments = createSegmentService({
		repo: new SqliteSegmentRepository(db, BTC_JPY.id),
		marketData: marketDataRepo,
		newsDeletedBefore: () => scoreRepo.newsDeletedBefore(),
		now: () => clock.now,
	});
	const dvolRepo = new SqliteDvolRepository(db);
	const backtestRepo = new SqliteBacktestRepository(db);
	const backtests = createBacktestService({
		repo: backtestRepo,
		marketData: collectedRepos,
		strategies,
		runner,
		judgments,
		scoring,
		segments,
		calendar,
		dvol: dvolRepo,
		now: () => 3_000,
	});
	const datasets = createDatasetService({
		repo: new SqliteDatasetRepository(db, backtestRepo),
		backtestRepo,
		backtests,
		segments,
		calendar,
		now: () => 3_000,
	});
	const adviceRepo = new SqliteAdviceRepository(db);
	adviceRepo.seedInstructions(DEFAULT_INSTRUCTIONS, 0);
	// テストから偽物の AI を差し替える
	const adviceAi: { model: GeminiModel } = { model: demoAdviceModel() };
	const advice = createAdviceService({
		repo: adviceRepo,
		backtests,
		backtestRepo,
		model: {
			unavailable: (id) => adviceAi.model.unavailable(id),
			generate: (...a) => adviceAi.model.generate(...a),
		},
		appBuiltAt: null,
		now: () => clock.now,
	});
	// 常駐処理は動かさず、テストから trading.tick() と trading.onTrades() を呼ぶ
	const tradingRepo = new SqliteTradingRepository(db);
	const trading = createTradingService({
		repo: tradingRepo,
		strategies,
		judgments,
		calendar,
		dvol: dvolRepo,
		marketData: collectedRepos as [
			SqliteMarketDataRepository,
			...SqliteMarketDataRepository[],
		],
		market: (id) => liveOf(id).current,
		now: () => clock.now,
		fees: TEST_FEE_RATES,
	});
	const analysisExport = createAnalysisExportService({
		repo: new SqliteAnalysisExportRepository(db),
		zip: createZip,
		scoreRepo,
		backtestRepo,
		marketData,
		dvol: dvolRepo,
		now: () => clock.now,
	});
	// 定期の削除は動かさず、テストから retention.tick() を呼ぶ
	const retention = createRetentionService({
		repo: new SqliteRetentionRepository(db),
		marketData: collectedRepos,
		dvol: dvolRepo,
		now: () => clock.now,
	});
	// 取得は自動では動かさず、テストから dvol.run() を呼ぶ。取得元の中身は dvolFeed.fetch を差し替える
	const dvolFeed: { fetch: FetchDvol } = { fetch: async () => [] };
	const dvol = createDvolService({
		repo: dvolRepo,
		fetchDvol: (from, to) => dvolFeed.fetch(from, to),
		keepFrom: () => retention.marketDataKeepFrom(),
		now: () => clock.now,
	});
	const scoringAnalysis = createScoringAnalysis({
		repo: new SqliteScoringAnalysisRepository(db),
		marketData,
		judgments,
		activeCriteriaVersion: () => scoreRepo.activeCriteriaVersion(),
		activeModel: () => scoreRepo.model(DEFAULT_SCORING_MODEL),
		now: () => clock.now,
	});
	const compatible = createCompatibleService({
		repo: new SqliteCompatibleRepository(db),
		listModels: demoCompatibleModels,
		now: () => clock.now,
	});
	const app = createApp({
		isDbReachable: () => true,
		appBuiltAt: null,
		marketData,
		marketDataByInstrument: [marketData, ethMarketData],
		market,
		marketByInstrument,
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
		segments,
		datasets,
		compatible,
		calendar,
		dvol,
		...over,
	});
	return {
		app,
		db,
		marketData,
		ethMarketData,
		marketDataRepo,
		repoOf,
		market,
		strategies,
		backtests,
		backtestRepo,
		segments,
		datasets,
		advice,
		adviceRepo,
		adviceAi,
		live,
		liveOf,
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
		calendar,
		icalFeeds,
		eventJobs,
		dvol,
		dvolRepo,
		dvolFeed,
	};
}
