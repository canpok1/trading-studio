import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { createAdviceService } from "./advice/advice-domain";
import { demoAdviceModel } from "./advice/fake-model-infra";
import { DEFAULT_INSTRUCTIONS } from "./advice/prompt-domain";
import { SqliteAdviceRepository } from "./advice/repository-infra";
import { createCompatibleService } from "./ai/ai-domain";
import {
	compatibleModel,
	fetchCompatibleModels,
	routedModel,
	SqliteCompatibleRepository,
} from "./ai/compatible-infra";
import { demoCompatibleModels } from "./ai/fake-models-infra";
import { DEFAULT_SCORING_MODEL, isCompatibleModel } from "./ai/model-domain";
import { createAnalysisExportService } from "./analysis-export/analysis-export-domain";
import { SqliteAnalysisExportRepository } from "./analysis-export/repository-infra";
import { createZip } from "./analysis-export/zip-infra";
import { createApp } from "./app";
import { createBacktestService } from "./backtests/backtests-domain";
import { SqliteBacktestRepository } from "./backtests/repository-infra";
import { workerRunner } from "./backtests/worker-runner-infra";
import { createCalendarService } from "./calendar/calendar-domain";
import { icalFeed } from "./calendar/ical-infra";
import { SqliteCalendarRepository } from "./calendar/repository-infra";
import { coincheckFeed } from "./collector/coincheck-infra";
import { createCollector } from "./collector/collector-domain";
import { demoFeedOf } from "./collector/fake-feed-infra";
import { createDatasetService } from "./datasets/datasets-domain";
import { SqliteDatasetRepository } from "./datasets/repository-infra";
import { migrateDb } from "./db/migrate-infra";
import { isDbReachable, openDb } from "./db/open-infra";
import { deribitDvol } from "./dvol/deribit-infra";
import { createDvolService } from "./dvol/dvol-domain";
import { demoDvol } from "./dvol/fake-deribit-infra";
import { SqliteDvolRepository } from "./dvol/repository-infra";
import { createJudgmentService } from "./judgments/judgments-domain";
import { createMarketService } from "./market/market-domain";
import { COLLECTED, DEFAULT_INSTRUMENT } from "./market-data/instrument-domain";
import { createMarketDataService } from "./market-data/market-data-domain";
import { SqliteMarketDataRepository } from "./market-data/repository-infra";
import { mcpRoutes } from "./mcp/mcp-app";
import { BACKTEST_WAIT_MS } from "./mcp/tool-app";
import { createNewsCollector, newsDelayMs } from "./news/collector-domain";
import { demoFetchFeed } from "./news/fake-feed-infra";
import { demoScoreModel } from "./news/fake-model-infra";
import { geminiModel } from "./news/gemini-infra";
import { createNewsService, DEFAULT_NEWS_SOURCES } from "./news/news-domain";
import { DEFAULT_CRITERIA } from "./news/prompt-domain";
import { SqliteNewsRepository } from "./news/repository-infra";
import { httpFetchText, rssFeed } from "./news/rss-infra";
import { SqliteScoreRepository } from "./news/score-repository-infra";
import { createScorer } from "./news/scorer-domain";
import { createScoringService } from "./news/scoring-domain";
import { SqliteRetentionRepository } from "./retention/repository-infra";
import { createRetentionService } from "./retention/retention-domain";
import { SqliteScoringAnalysisRepository } from "./scoring-analysis/repository-infra";
import { createScoringAnalysis } from "./scoring-analysis/scoring-analysis-domain";
import { SqliteSegmentRepository } from "./segments/repository-infra";
import { createSegmentService } from "./segments/segments-domain";
import { slowRequestLog, watchEventLoopLag } from "./server/slow-log-app";
import { serveFrontend } from "./server/static-app";
import { readAppBuiltAt } from "./server/version-infra";
import { SqliteStrategyRepository } from "./strategies/repository-infra";
import { createStrategyService } from "./strategies/strategies-domain";
import { SqliteTradingRepository } from "./trading/repository-infra";
import type { TradingEngine } from "./trading/trading-domain";
import { createTradingService } from "./trading/trading-domain";

const hostname = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const distDir =
	process.env.STATIC_DIR ??
	fileURLToPath(new URL("../../frontend/dist", import.meta.url));
// 既定はリポジトリ直下の data/。bun run --filter は各パッケージを作業ディレクトリにして動くため、作業ディレクトリ基準にしない
const dbPath =
	process.env.DB_PATH ??
	fileURLToPath(new URL("../../../data/trading-studio.db", import.meta.url));

const appBuiltAt = readAppBuiltAt();
const db = openDb(dbPath);
try {
	const { applied, backupPath } = migrateDb(db, {
		backupDir: join(dirname(dbPath), "backup"),
		now: Date.now(),
	});
	if (applied > 0) {
		console.log(
			`migrated ${applied} file(s)${backupPath ? `, backup: ${backupPath}` : ""}`,
		);
	}
} catch (e) {
	// DB が中途半端な状態のまま動かさない
	console.error("migration failed", e);
	process.exit(1);
}

const marketDataRepo = new SqliteMarketDataRepository(db, DEFAULT_INSTRUMENT);
marketDataRepo.failInterrupted(Date.now());
const backtestRepo = new SqliteBacktestRepository(db);
backtestRepo.failInterrupted(Date.now());
const strategies = createStrategyService(new SqliteStrategyRepository(db));

// 自動取引は収集より後に作るので、届いた約定は作った後から渡す
let trading: TradingEngine | null = null;
// 収集はサーバーが動いている間は常に行う（ON/OFF は作らない）
/** 収集する銘柄ごとの足の読み書き */
const collectedRepos = COLLECTED.map((instrument) => {
	if (instrument.id === DEFAULT_INSTRUMENT.id) return marketDataRepo;
	const repo = new SqliteMarketDataRepository(db, instrument);
	repo.failInterrupted(Date.now());
	return repo;
});
const collectors = COLLECTED.map((instrument, i) =>
	createCollector({
		// 自動取引は BTC/JPY だけを扱う（#280 まで）
		onTrades:
			instrument.id === DEFAULT_INSTRUMENT.id
				? (trades) => trading?.onTrades(trades)
				: undefined,
		// E2E では取引所へつながず、偽物の約定を流す
		feed:
			process.env.MARKET_FEED === "demo"
				? demoFeedOf(instrument)
				: coincheckFeed(instrument),
		repo: collectedRepos[i] as SqliteMarketDataRepository,
	}),
);
const collector = collectors[
	COLLECTED.findIndex((i) => i.id === DEFAULT_INSTRUMENT.id)
] as (typeof collectors)[number];
const collectorTimer = setInterval(() => {
	for (const c of collectors) c.tick();
}, 1_000);

const newsRepo = new SqliteNewsRepository(db);
newsRepo.seedSources(DEFAULT_NEWS_SOURCES, Date.now());
const newsCollector = createNewsCollector({
	repo: newsRepo,
	// E2E では RSS の取得元へつながず、偽物の記事を返す
	fetchFeed:
		process.env.NEWS_FEED === "demo" ? demoFetchFeed() : rssFeed(httpFetchText),
});
const newsTimer = setInterval(() => newsCollector.tick(), 1_000);
newsCollector.tick();

// 取得元の既定は持たない。利用者が設定するまで、アプリが持つ過去の予定だけを使う
const calendar = createCalendarService({
	repo: new SqliteCalendarRepository(db),
	fetchIcal: icalFeed(httpFetchText),
	appBuiltAt,
	...(process.env.SCORING_MODEL === "demo"
		? { retryDelaysMs: [1_000, 1_000, 1_000] }
		: {}),
});
const calendarTimer = setInterval(() => calendar.tick(), 60_000);
calendar.tick();

const scoreRepo = new SqliteScoreRepository(db);
scoreRepo.seedCriteria(DEFAULT_CRITERIA, Date.now());
const compatibleRepo = new SqliteCompatibleRepository(db);
/** 選んだモデルの接続先（Gemini 直結か OpenAI 互換か）で問い合わせる */
const aiModel = (timeoutMs: number) =>
	routedModel(
		geminiModel(() => scoreRepo.apiKey(), { timeoutMs }),
		compatibleModel(() => compatibleRepo.connection(), { timeoutMs }),
	);
const scorer = createScorer({
	repo: scoreRepo,
	// E2E では Gemini へつながず、決まった点数を返す
	model:
		process.env.SCORING_MODEL === "demo" ? demoScoreModel() : aiModel(60_000),
	rule: () => scoreRepo.aggregationRule(),
	appBuiltAt,
	jobs: calendar.jobs,
	// E2E では再試行を待ちきれないので短くする
	...(process.env.SCORING_MODEL === "demo"
		? { minIntervalMs: 0, retryDelaysMs: [1_000, 1_000, 1_000] }
		: {}),
});
const scorerTimer = setInterval(() => scorer.tick(), 1_000);

const judgments = createJudgmentService({
	repo: scoreRepo,
	newsDelayMs: () => newsDelayMs(newsRepo),
});

const dvolRepo = new SqliteDvolRepository(db);
const tradingEngine = createTradingService({
	repo: new SqliteTradingRepository(db),
	strategies,
	judgments,
	calendar,
	dvol: dvolRepo,
	marketData: marketDataRepo,
	market: () => collector.live(),
});
trading = tradingEngine;
const tradingTimer = setInterval(() => tradingEngine.tick(), 1_000);

const retention = createRetentionService({
	repo: new SqliteRetentionRepository(db),
	marketData: collectedRepos,
	dvol: dvolRepo,
});
const retentionTimer = setInterval(() => retention.tick(), 60_000);
retention.tick();

// 起動時に欠けている過去分を取り込み、その後は1時間ごとに取る
const dvol = createDvolService({
	repo: dvolRepo,
	// E2E では Deribit へつながず、偽物の足を返す
	fetchDvol: process.env.DVOL_FEED === "demo" ? demoDvol() : deribitDvol,
	keepFrom: () => retention.marketDataKeepFrom(),
});
const dvolTimer = setInterval(() => dvol.tick(), 60_000);
dvol.tick();

const segments = createSegmentService({
	repo: new SqliteSegmentRepository(db, DEFAULT_INSTRUMENT.id),
	marketData: marketDataRepo,
	newsDeletedBefore: () => scoreRepo.newsDeletedBefore(),
});
const segmentTimer = setInterval(() => segments.tick(), 60_000);
segments.tick();

const marketData = createMarketDataService(marketDataRepo, {
	// 過去の足を取り込んだら、その期間の相場データをすぐ作る（相場の分類は BTC/JPY で付ける）
	onSettled: (job) => job.status === "done" && segments.refresh(),
});
const marketDataByInstrument = collectedRepos.map((repo) =>
	repo === marketDataRepo ? marketData : createMarketDataService(repo),
);
const scoring = createScoringService({
	repo: scoreRepo,
	newsRepo,
	scorer,
});
const compatible = createCompatibleService({
	repo: compatibleRepo,
	onSaved: () => {
		// 採点が OpenAI 互換を使っていれば、前の設定で失敗したものを新しい設定でやり直す
		if (!isCompatibleModel(scoreRepo.model(DEFAULT_SCORING_MODEL))) return;
		scoreRepo.retryAllFailed(Date.now());
		scorer.clearFailure();
	},
	// E2E では接続先へつながず、決まった一覧を返す
	listModels:
		process.env.SCORING_MODEL === "demo"
			? demoCompatibleModels
			: fetchCompatibleModels,
});
const backtests = createBacktestService({
	repo: backtestRepo,
	marketData: collectedRepos,
	strategies,
	runner: workerRunner,
	judgments,
	scoring,
	segments,
	calendar,
	dvol: dvolRepo,
});
const datasetRepo = new SqliteDatasetRepository(db, backtestRepo);
datasetRepo.failInterrupted(Date.now());
const datasets = createDatasetService({
	repo: datasetRepo,
	backtestRepo,
	backtests,
	segments,
	calendar,
});
const adviceRepo = new SqliteAdviceRepository(db);
adviceRepo.failInterrupted();
adviceRepo.seedInstructions(DEFAULT_INSTRUCTIONS, Date.now());
const advice = createAdviceService({
	repo: adviceRepo,
	backtests,
	backtestRepo,
	// E2E では Gemini へつながず、決まったアドバイスを返す
	model:
		process.env.SCORING_MODEL === "demo"
			? demoAdviceModel()
			: // アドバイスは応答が長く、Pro のモデルでは時間がかかるので長めに待つ
				aiModel(180_000),
	appBuiltAt,
});
const scoringAnalysis = createScoringAnalysis({
	repo: new SqliteScoringAnalysisRepository(db),
	marketData,
	judgments,
	activeCriteriaVersion: () => scoreRepo.activeCriteriaVersion(),
	activeModel: () => scoreRepo.model(DEFAULT_SCORING_MODEL),
});
const news = createNewsService({
	repo: newsRepo,
	collector: newsCollector,
	rule: () => scoreRepo.aggregationRule(),
	rescoring: () => scorer.rescoring(),
});
const market = createMarketService({ collector, repo: marketDataRepo });
const server = new Hono()
	.use("/api/*", slowRequestLog())
	// 画面の配信（GET *）より前に置く
	.route(
		"/mcp",
		mcpRoutes({
			strategies,
			backtests,
			marketData,
			marketDataByInstrument,
			segments,
			datasets,
			scoring,
			news,
			judgments,
			accuracy: scoringAnalysis,
			trading: tradingEngine,
			market,
			advice,
			calendar,
			dvol,
		}),
	)
	.route(
		"/",
		createApp({
			isDbReachable: () => isDbReachable(db),
			appBuiltAt,
			marketData,
			marketDataByInstrument,
			market,
			strategies,
			backtests,
			advice,
			news,
			scoring,
			judgments,
			trading: tradingEngine,
			analysisExport: createAnalysisExportService({
				repo: new SqliteAnalysisExportRepository(db),
				zip: createZip,
				scoreRepo,
				backtestRepo,
				marketData,
				dvol: dvolRepo,
			}),
			retention,
			accuracy: scoringAnalysis,
			segments,
			datasets,
			compatible,
			calendar,
			dvol,
		}),
	);
serveFrontend(server, distDir);
const stopLagWatch = watchEventLoopLag();

const http = Bun.serve({
	hostname,
	port,
	fetch: (req, srv) => {
		// run_backtest と試し採点は終わりを待つ間なにも送らないので、既定の10秒で切られないようにする。
		// 試し採点は記事ごとに問い合わせの間を5秒空けるので、5件で数十秒かかる
		const path = new URL(req.url).pathname;
		if (path === "/mcp" || path === "/api/scoring/trial") {
			srv.timeout(req, BACKTEST_WAIT_MS / 1_000 + 30);
		}
		return server.fetch(req);
	},
});
console.log(`listening on http://${hostname}:${port}, db: ${dbPath}`);

// コンテナでは PID 1 になり、ハンドラが無いと SIGTERM が無視されて入れ替えのたびに強制終了を待つことになる
for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, async () => {
		clearInterval(collectorTimer);
		clearInterval(newsTimer);
		clearInterval(calendarTimer);
		clearInterval(scorerTimer);
		clearInterval(tradingTimer);
		clearInterval(retentionTimer);
		clearInterval(segmentTimer);
		clearInterval(dvolTimer);
		stopLagWatch();
		for (const c of collectors) c.stop();
		await http.stop();
		db.$client.close();
		process.exit(0);
	});
}
