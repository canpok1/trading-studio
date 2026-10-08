import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { demoAdviceModel } from "./advice/fake-model";
import { DEFAULT_INSTRUCTIONS } from "./advice/prompt";
import { AdviceRepository } from "./advice/repository";
import { createAdviceService } from "./advice/service";
import { AnalysisExportRepository } from "./analysis-export/repository";
import { createAnalysisExportService } from "./analysis-export/service";
import { createApp } from "./app";
import { BacktestRepository } from "./backtests/repository";
import { createBacktestService } from "./backtests/service";
import { workerRunner } from "./backtests/worker-runner";
import { coincheckFeed } from "./collector/coincheck";
import { createCollector } from "./collector/collector";
import { demoFeed } from "./collector/fake-feed";
import { DatasetRepository } from "./datasets/repository";
import { createDatasetService } from "./datasets/service";
import { migrateDb } from "./db/migrate";
import { isDbReachable, openDb } from "./db/open";
import { createJudgmentService } from "./judgments/service";
import { createMarketService } from "./market/service";
import { MarketDataRepository } from "./market-data/repository";
import { createMarketDataService } from "./market-data/service";
import { BACKTEST_WAIT_MS, mcpRoutes } from "./mcp/server";
import {
	createNewsCollector,
	httpFetchFeed,
	newsDelayMs,
} from "./news/collector";
import { demoFetchFeed } from "./news/fake-feed";
import { demoScoreModel } from "./news/fake-model";
import { geminiModel } from "./news/gemini";
import { DEFAULT_CRITERIA } from "./news/prompt";
import { NewsRepository } from "./news/repository";
import { ScoreRepository } from "./news/score-repository";
import { createScorer } from "./news/scorer";
import { createScoringService } from "./news/scoring-service";
import { createNewsService, DEFAULT_NEWS_SOURCES } from "./news/service";
import { RetentionRepository } from "./retention/repository";
import { createRetentionService } from "./retention/service";
import { ScoringAnalysisRepository } from "./scoring-analysis/repository";
import { createScoringAnalysis } from "./scoring-analysis/service";
import { slowRequestLog, watchEventLoopLag } from "./slow-log";
import { serveFrontend } from "./static";
import { createStrategyService } from "./strategies/service";
import { TradingRepository } from "./trading/repository";
import type { TradingEngine } from "./trading/service";
import { createTradingService } from "./trading/service";
import { readAppBuiltAt } from "./version";

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

const marketDataRepo = new MarketDataRepository(db);
marketDataRepo.failInterrupted(Date.now());
const backtestRepo = new BacktestRepository(db);
backtestRepo.failInterrupted(Date.now());
const strategies = createStrategyService(db);

// E2E で収集の停止を再現するためのファイル。あれば偽物の取引所が止まる
const demoDownFile = join(dirname(dbPath), "feed-down");
// 自動取引は収集より後に作るので、届いた約定は作った後から渡す
let trading: TradingEngine | null = null;
// 収集はサーバーが動いている間は常に行う（ON/OFF は作らない）
const collector = createCollector({
	onTrades: (trades) => trading?.onTrades(trades),
	// E2E では取引所へつながず、偽物の約定を流す
	feed:
		process.env.MARKET_FEED === "demo"
			? demoFeed({ isDown: () => existsSync(demoDownFile) })
			: coincheckFeed(),
	repo: marketDataRepo,
});
const collectorTimer = setInterval(() => collector.tick(), 1_000);

const newsRepo = new NewsRepository(db);
newsRepo.seedSources(DEFAULT_NEWS_SOURCES, Date.now());
// E2E で取得元の失敗を再現するためのファイル。あれば偽物の取得元が失敗する
const newsDownFile = join(dirname(dbPath), "news-down");
const newsCollector = createNewsCollector({
	repo: newsRepo,
	// E2E では RSS の取得元へつながず、偽物の記事を返す
	fetchFeed:
		process.env.NEWS_FEED === "demo"
			? demoFetchFeed({ isDown: () => existsSync(newsDownFile) })
			: httpFetchFeed,
});
const newsTimer = setInterval(() => newsCollector.tick(), 1_000);
newsCollector.tick();

const scoreRepo = new ScoreRepository(db);
scoreRepo.seedCriteria(DEFAULT_CRITERIA, Date.now());
// E2E で採点の失敗を再現するためのファイル。あれば偽物の AI が失敗する
const scoringDownFile = join(dirname(dbPath), "scoring-down");
const scorer = createScorer({
	repo: scoreRepo,
	// E2E では Gemini へつながず、決まった点数を返す
	model:
		process.env.SCORING_MODEL === "demo"
			? demoScoreModel({ isDown: () => existsSync(scoringDownFile) })
			: geminiModel(() => scoreRepo.apiKey()),
	rule: () => scoreRepo.aggregationRule(),
	appBuiltAt,
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

const tradingEngine = createTradingService({
	repo: new TradingRepository(db),
	strategies,
	judgments,
	marketData: marketDataRepo,
	market: () => collector.live(),
});
trading = tradingEngine;
const tradingTimer = setInterval(() => tradingEngine.tick(), 1_000);

const retention = createRetentionService({
	repo: new RetentionRepository(db),
	marketData: marketDataRepo,
});
const retentionTimer = setInterval(() => retention.tick(), 60_000);
retention.tick();

const datasets = createDatasetService({
	repo: new DatasetRepository(db),
	marketData: marketDataRepo,
	newsDeletedBefore: () => scoreRepo.newsDeletedBefore(),
});
const datasetTimer = setInterval(() => datasets.tick(), 60_000);
datasets.tick();

const marketData = createMarketDataService(marketDataRepo, {
	// 過去の足を取り込んだら、その期間のデータセットをすぐ作る
	onSettled: (job) => job.status === "done" && datasets.refresh(),
});
const scoring = createScoringService({
	repo: scoreRepo,
	newsRepo,
	scorer,
});
const backtests = createBacktestService({
	repo: backtestRepo,
	marketData: marketDataRepo,
	strategies,
	runner: workerRunner,
	judgments,
	scoring,
	datasets,
});
const adviceRepo = new AdviceRepository(db);
adviceRepo.failInterrupted();
adviceRepo.seedInstructions(DEFAULT_INSTRUCTIONS, Date.now());
// E2E でアドバイスの失敗を再現するためのファイル。あれば偽物の AI が失敗する
const adviceDownFile = join(dirname(dbPath), "advice-down");
const advice = createAdviceService({
	repo: adviceRepo,
	backtests,
	backtestRepo,
	// E2E では Gemini へつながず、決まったアドバイスを返す
	model:
		process.env.SCORING_MODEL === "demo"
			? demoAdviceModel({ isDown: () => existsSync(adviceDownFile) })
			: // アドバイスは応答が長く、Pro のモデルでは時間がかかるので長めに待つ
				geminiModel(() => scoreRepo.apiKey(), { timeoutMs: 180_000 }),
	appBuiltAt,
});
const scoringAnalysis = createScoringAnalysis({
	repo: new ScoringAnalysisRepository(db),
	marketData,
	judgments,
	activeCriteriaVersion: () => scoreRepo.activeCriteriaVersion(),
});
const news = createNewsService({
	repo: newsRepo,
	collector: newsCollector,
	rule: () => scoreRepo.aggregationRule(),
	rescoring: () => scorer.rescoring(),
});
const server = new Hono()
	.use("/api/*", slowRequestLog())
	// 画面の配信（GET *）より前に置く
	.route(
		"/mcp",
		mcpRoutes({
			strategies,
			backtests,
			marketData,
			datasets,
			scoring,
			news,
			judgments,
			accuracy: scoringAnalysis,
			inUse: (id) => tradingEngine.inUse(id),
		}),
	)
	.route(
		"/",
		createApp({
			isDbReachable: () => isDbReachable(db),
			appBuiltAt,
			marketData,
			market: createMarketService({ collector, repo: marketDataRepo }),
			strategies,
			backtests,
			advice,
			news,
			scoring,
			judgments,
			trading: tradingEngine,
			analysisExport: createAnalysisExportService({
				repo: new AnalysisExportRepository(db),
				scoreRepo,
				backtestRepo,
				marketData,
			}),
			retention,
			accuracy: scoringAnalysis,
			datasets,
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
		clearInterval(scorerTimer);
		clearInterval(tradingTimer);
		clearInterval(retentionTimer);
		clearInterval(datasetTimer);
		stopLagWatch();
		collector.stop();
		await http.stop();
		db.$client.close();
		process.exit(0);
	});
}
