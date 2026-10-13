import { Hono } from "hono";
import type { AdviceService } from "./advice/types";
import { aiRoutes } from "./ai/ai-app";
import type { CompatibleService } from "./ai/types-domain";
import type { AnalysisExportService } from "./analysis-export/types";
import type { BacktestService } from "./backtests/types";
import type { DatasetService } from "./datasets/types";
import { judgmentRoutes } from "./judgments/judgments-app";
import type { JudgmentService } from "./judgments/types-domain";
import { marketRoutes } from "./market/market-app";
import type { MarketService } from "./market/types-domain";
import { marketDataRoutes } from "./market-data/market-data-app";
import type { MarketDataService } from "./market-data/types-domain";
import type { NewsService, ScoringService } from "./news/types";
import { retentionRoutes } from "./retention/retention-app";
import type { RetentionService } from "./retention/types-domain";
import { adviceRoutes } from "./routes/advice";
import { backtestRoutes } from "./routes/backtests";
import { datasetRoutes, datasetRunRoutes } from "./routes/datasets";
import { exportRoutes } from "./routes/export";
import { newsRoutes } from "./routes/news";
import { scoringRoutes } from "./routes/scoring";
import { tradingRoutes } from "./routes/trading";
import type { AccuracyService } from "./scoring-analysis/types";
import { segmentRoutes } from "./segments/segments-app";
import type { SegmentService } from "./segments/types-domain";
import { strategyRoutes } from "./strategies/strategies-app";
import type { StrategyService } from "./strategies/types-domain";
import type { TradingService } from "./trading/types";

export type AppDeps = {
	isDbReachable: () => boolean;
	/** アプリのバージョン（ビルド日時）。開発版は null */
	appBuiltAt: number | null;
	marketData: MarketDataService;
	market: MarketService;
	strategies: StrategyService;
	backtests: BacktestService;
	advice: AdviceService;
	news: NewsService;
	scoring: ScoringService;
	judgments: JudgmentService;
	trading: TradingService;
	analysisExport: AnalysisExportService;
	retention: RetentionService;
	accuracy: AccuracyService;
	segments: SegmentService;
	datasets: DatasetService;
	compatible: CompatibleService;
};

// frontend は Hono RPC でこの型を使う。Bun 固有の API はここに持ち込まない（frontend の型チェックに Bun の型を入れないため）
export function createApp({
	isDbReachable,
	appBuiltAt,
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
	accuracy,
	segments,
	datasets,
	compatible,
}: AppDeps) {
	const api = new Hono()
		.get("/health", (c) =>
			c.json({
				status: "ok" as const,
				db: isDbReachable() ? ("ok" as const) : ("error" as const),
			}),
		)
		.get("/version", (c) => c.json({ builtAt: appBuiltAt }))
		.route("/data", marketDataRoutes(marketData))
		.route("/market", marketRoutes(market))
		.route(
			"/strategies",
			strategyRoutes(strategies, (id) => trading.strategyLock(id)),
		)
		.route("/backtests", backtestRoutes(backtests, datasets))
		.route("/datasets", datasetRoutes(datasets))
		.route("/dataset-runs", datasetRunRoutes(datasets))
		.route("/segments", segmentRoutes(segments, judgments))
		.route("/advice", adviceRoutes(advice))
		.route("/ai", aiRoutes(compatible))
		.route("/news", newsRoutes(news))
		.route("/scoring", scoringRoutes(scoring, accuracy))
		.route("/judgments", judgmentRoutes(judgments))
		.route("/trading", tradingRoutes(trading))
		.route("/export", exportRoutes(analysisExport))
		.route("/retention", retentionRoutes(retention));
	return new Hono().route("/api", api);
}

export type AppType = ReturnType<typeof createApp>;
