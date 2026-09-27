import { Hono } from "hono";
import type { AdviceService } from "./advice/types";
import type { AnalysisExportService } from "./analysis-export/types";
import type { BacktestService } from "./backtests/types";
import type { JudgmentService } from "./judgments/types";
import type { MarketService } from "./market/types";
import type { MarketDataService } from "./market-data/types";
import type { NewsService, ScoringService } from "./news/types";
import type { RetentionService } from "./retention/types";
import { adviceRoutes } from "./routes/advice";
import { backtestRoutes } from "./routes/backtests";
import { exportRoutes } from "./routes/export";
import { judgmentRoutes } from "./routes/judgments";
import { marketRoutes } from "./routes/market";
import { marketDataRoutes } from "./routes/market-data";
import { newsRoutes } from "./routes/news";
import { retentionRoutes } from "./routes/retention";
import { scoringRoutes } from "./routes/scoring";
import { strategyRoutes } from "./routes/strategies";
import { tradingRoutes } from "./routes/trading";
import type { StrategyService } from "./strategies/types";
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
			strategyRoutes(strategies, () => trading.status().enabled),
		)
		.route("/backtests", backtestRoutes(backtests))
		.route("/advice", adviceRoutes(advice))
		.route("/news", newsRoutes(news))
		.route("/scoring", scoringRoutes(scoring))
		.route("/judgments", judgmentRoutes(judgments))
		.route("/trading", tradingRoutes(trading))
		.route("/export", exportRoutes(analysisExport))
		.route("/retention", retentionRoutes(retention));
	return new Hono().route("/api", api);
}

export type AppType = ReturnType<typeof createApp>;
