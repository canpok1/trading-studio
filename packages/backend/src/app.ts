import { Hono } from "hono";
import { adviceRoutes } from "./advice/advice-app";
import type { AdviceService } from "./advice/types-domain";
import { aiRoutes } from "./ai/ai-app";
import type { CompatibleService } from "./ai/types-domain";
import { exportRoutes } from "./analysis-export/analysis-export-app";
import type { AnalysisExportService } from "./analysis-export/types-domain";
import { backtestRoutes } from "./backtests/backtests-app";
import type { BacktestService } from "./backtests/types-domain";
import { calendarRoutes } from "./calendar/calendar-app";
import type { CalendarService } from "./calendar/types-domain";
import { datasetRoutes, datasetRunRoutes } from "./datasets/datasets-app";
import type { DatasetService } from "./datasets/types-domain";
import { judgmentRoutes } from "./judgments/judgments-app";
import type { JudgmentService } from "./judgments/types-domain";
import { marketRoutes } from "./market/market-app";
import type { MarketService } from "./market/types-domain";
import { marketDataRoutes } from "./market-data/market-data-app";
import type { MarketDataService } from "./market-data/types-domain";
import { newsRoutes } from "./news/news-app";
import { scoringRoutes } from "./news/scoring-app";
import type { NewsService, ScoringService } from "./news/types-domain";
import { retentionRoutes } from "./retention/retention-app";
import type { RetentionService } from "./retention/types-domain";
import type { AccuracyService } from "./scoring-analysis/types-domain";
import { segmentRoutes } from "./segments/segments-app";
import type { SegmentService } from "./segments/types-domain";
import { strategyRoutes } from "./strategies/strategies-app";
import type { StrategyService } from "./strategies/types-domain";
import { tradingRoutes } from "./trading/trading-app";
import type { TradingService } from "./trading/types-domain";

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
	calendar: CalendarService;
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
	calendar,
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
		.route("/strategies", strategyRoutes(strategies, trading))
		.route("/backtests", backtestRoutes(backtests, datasets))
		.route("/datasets", datasetRoutes(datasets))
		.route("/dataset-runs", datasetRunRoutes(datasets))
		.route("/segments", segmentRoutes(segments, judgments))
		.route("/advice", adviceRoutes(advice))
		.route("/ai", aiRoutes(compatible))
		.route("/news", newsRoutes(news))
		.route("/calendar", calendarRoutes(calendar))
		.route("/scoring", scoringRoutes(scoring, accuracy))
		.route("/judgments", judgmentRoutes(judgments))
		.route("/trading", tradingRoutes(trading))
		.route("/export", exportRoutes(analysisExport))
		.route("/retention", retentionRoutes(retention));
	return new Hono().route("/api", api);
}

export type AppType = ReturnType<typeof createApp>;
