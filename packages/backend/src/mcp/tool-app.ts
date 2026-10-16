// MCP の道具が共通で使う、依存の形・応答の形・入力の形

import * as z from "zod";
import type { AdviceService } from "../advice/types-domain";
import type { BacktestService } from "../backtests/types-domain";
import type { CalendarService } from "../calendar/types-domain";
import type { DatasetService } from "../datasets/types-domain";
import type { JudgmentService } from "../judgments/types-domain";
import type { MarketService } from "../market/types-domain";
import type { MarketDataService } from "../market-data/types-domain";
import type { NewsService, ScoringService } from "../news/types-domain";
import type { AccuracyService } from "../scoring-analysis/types-domain";
import type { SegmentService } from "../segments/types-domain";
import type { StrategyService } from "../strategies/types-domain";
import type { TradingService } from "../trading/types-domain";

import { parseTime } from "./views-domain";

export type McpDeps = {
	strategies: StrategyService;
	backtests: BacktestService;
	marketData: MarketDataService;
	segments: SegmentService;
	/** データセット（画面の呼び名。相場データを束ねたもの） */
	datasets: DatasetService;
	scoring: ScoringService;
	news: Pick<NewsService, "searchNews">;
	judgments: Pick<JudgmentService, "rule" | "current" | "series" | "preview">;
	accuracy: AccuracyService;
	/** 戦略ごとの自動取引。読むだけで、オンオフは道具にしない。条件の変更を止める理由も引く */
	trading: Pick<
		TradingService,
		| "runs"
		| "run"
		| "performance"
		| "watch"
		| "orders"
		| "orderSummary"
		| "order"
		| "strategyLock"
	>;
	market: Pick<MarketService, "latest" | "bars">;
	advice: Pick<AdviceService, "get">;
	/** 予定。読むだけで、取得元と評価基準の変更は道具にしない */
	calendar: Pick<
		CalendarService,
		"listSources" | "status" | "criteria" | "listEvents"
	>;
	/** run_backtest が終わりを待つ時間。過ぎたら実行中のまま返し、get_backtest で続きを見てもらう */
	backtestWaitMs?: number;
	sleep?: (ms: number) => Promise<void>;
};

/** 既定値を埋めた依存。各機能の道具の登録に渡す */
export type ToolDeps = McpDeps &
	Required<Pick<McpDeps, "backtestWaitMs" | "sleep">>;

/** run_backtest が終わりを待つ時間の既定。HTTP の無通信の切断はこれより長くする（main.ts） */
export const BACKTEST_WAIT_MS = 120_000;

export const text = (v: unknown) => ({
	content: [
		{
			type: "text" as const,
			text: typeof v === "string" ? v : JSON.stringify(v, null, 2),
		},
	],
});
export const fail = (message: string, detail?: unknown) => ({
	...text(detail === undefined ? { message } : { message, detail }),
	isError: true,
});

export const paramsSchema = z
	.record(z.string(), z.unknown())
	.describe("条件セット。形は get_guide を参照");

/** 時点の入力。省けば今。読めなければエラーの応答 */
export function atTime(at: string | undefined) {
	if (at === undefined) return { at: undefined };
	const t = parseTime(at);
	return t === null
		? fail("at はタイムゾーン付きの ISO 8601 か YYYY-MM-DD で書く")
		: { at: t };
}

export const atSchema = z
	.string()
	.optional()
	.describe(
		"市場評価の時点。ISO 8601（タイムゾーン付き）か YYYY-MM-DD（JST の 0:00）。省けば今",
	);

export const readOnly = { readOnlyHint: true, openWorldHint: false };
