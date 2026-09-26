import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { createApp } from "./app";
import { BacktestRepository } from "./backtests/repository";
import { createBacktestService } from "./backtests/service";
import { workerRunner } from "./backtests/worker-runner";
import { coincheckFeed } from "./collector/coincheck";
import { createCollector } from "./collector/collector";
import { demoFeed } from "./collector/fake-feed";
import { migrateDb } from "./db/migrate";
import { isDbReachable, openDb } from "./db/open";
import { createJudgmentService } from "./judgments/service";
import { createMarketService } from "./market/service";
import { MarketDataRepository } from "./market-data/repository";
import { createMarketDataService } from "./market-data/service";
import { createNewsCollector, httpFetchFeed } from "./news/collector";
import { demoFetchFeed } from "./news/fake-feed";
import { demoScoreModel } from "./news/fake-model";
import { geminiModel } from "./news/gemini";
import { DEFAULT_CRITERIA } from "./news/prompt";
import { NewsRepository } from "./news/repository";
import { ScoreRepository } from "./news/score-repository";
import { createScorer } from "./news/scorer";
import { createScoringService } from "./news/scoring-service";
import { createNewsService, DEFAULT_NEWS_SOURCES } from "./news/service";
import { serveFrontend } from "./static";
import { createStrategyService } from "./strategies/service";

const hostname = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const distDir =
	process.env.STATIC_DIR ??
	fileURLToPath(new URL("../../frontend/dist", import.meta.url));
// 既定はリポジトリ直下の data/。bun run --filter は各パッケージを作業ディレクトリにして動くため、作業ディレクトリ基準にしない
const dbPath =
	process.env.DB_PATH ??
	fileURLToPath(new URL("../../../data/trading-studio.db", import.meta.url));

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
// 収集はサーバーが動いている間は常に行う（ON/OFF は作らない）
const collector = createCollector({
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
			: geminiModel(process.env.GEMINI_API_KEY),
	rule: () => scoreRepo.aggregationRule(),
	// E2E では再試行を待ちきれないので短くする
	...(process.env.SCORING_MODEL === "demo"
		? { minIntervalMs: 0, retryDelaysMs: [1_000, 1_000, 1_000] }
		: {}),
});
const scorerTimer = setInterval(() => scorer.tick(), 1_000);

const judgments = createJudgmentService({ repo: scoreRepo });

const server = new Hono().route(
	"/",
	createApp({
		isDbReachable: () => isDbReachable(db),
		marketData: createMarketDataService(marketDataRepo),
		market: createMarketService({ collector, repo: marketDataRepo }),
		strategies,
		backtests: createBacktestService({
			repo: backtestRepo,
			marketData: marketDataRepo,
			strategies,
			runner: workerRunner,
			judgments,
		}),
		news: createNewsService({ repo: newsRepo, collector: newsCollector }),
		scoring: createScoringService({
			repo: scoreRepo,
			newsRepo,
			scorer,
		}),
		judgments,
	}),
);
serveFrontend(server, distDir);

const http = Bun.serve({ hostname, port, fetch: server.fetch });
console.log(`listening on http://${hostname}:${port}, db: ${dbPath}`);

// コンテナでは PID 1 になり、ハンドラが無いと SIGTERM が無視されて入れ替えのたびに強制終了を待つことになる
for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, async () => {
		clearInterval(collectorTimer);
		clearInterval(newsTimer);
		clearInterval(scorerTimer);
		collector.stop();
		await http.stop();
		db.$client.close();
		process.exit(0);
	});
}
