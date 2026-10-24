// 偽物の API が返す値のひな形。テストで変えたいところだけ上書きする
import type {
	AccuracySummary,
	AccuracySummaryResult,
	AutoTradingStatus,
	BacktestRun,
	CurrentJudgment,
	ImportJob,
	JudgmentSeries,
	NewsCollectorStatus,
	NewsItem,
	NewsScore,
	NewsSource,
	ScorerStatus,
	StoredOrder,
	StoredStrategy,
	TimeframeCoverage,
	TradingPerformance,
} from "@trading-studio/backend";
import type {
	AggregationRule,
	ConditionSet,
	Judge,
	ScoredNews,
	TemplateId,
	Timeframe,
} from "@trading-studio/core";
import {
	BTC_JPY,
	COINCHECK,
	COINCHECK_EXCHANGE,
	candleStart,
	DEFAULT_AGGREGATION_RULE,
	JUDGMENT_VALUES,
	judgeAt,
	judgmentBreakdown,
	strategyTemplate,
	TIMEFRAME_MS,
} from "@trading-studio/core";
import type { InferResponseType } from "hono/client";
import type { ApiClient } from "../src/shared/lib/api";

export function tradingRun(
	over: Partial<AutoTradingStatus> & Pick<AutoTradingStatus, "id" | "name">,
): AutoTradingStatus {
	return {
		accountId: over.id,
		instrument: BTC_JPY,
		enabled: false,
		mode: "paper",
		nextEvalAt: null,
		startedAt: null,
		ranSinceReset: over.enabled ?? false,
		waitingForMarket: false,
		dailyLoss: { loss: 0, limit: null, blocked: false },
		account: {
			initialCash: 1_000_000,
			cash: 1_000_000,
			position: { quantity: 0, entryPrice: null, openedAt: null },
			lots: [],
			openOrderCount: 0,
			resetAt: 0,
			equity: 1_000_000,
		},
		strategyLock: null,
		...over,
	};
}

type MarketLatest = InferResponseType<
	ApiClient["api"]["market"]["latest"]["$get"]
>;

/** 価格の収集が動いていて、価格がまだ無い状態 */
export function marketLatest(over: Partial<MarketLatest> = {}): MarketLatest {
	return {
		price: null,
		priceTime: null,
		price24hAgo: null,
		forming: null,
		collector: {
			state: "running",
			stoppedSince: null,
			error: null,
			retryAt: null,
			lastReceivedAt: null,
		},
		...over,
	};
}

export function newsSource(
	over: Partial<NewsSource> & Pick<NewsSource, "id" | "name">,
): NewsSource {
	return {
		url: `https://news.example/${over.id}`,
		language: "ja",
		enabled: true,
		createdAt: 0,
		lastSuccessAt: 0,
		lastError: null,
		errorSince: null,
		...over,
	};
}

/** ニュースの取得が動いている状態 */
export function newsCollectorStatus(
	over: Partial<NewsCollectorStatus> = {},
): NewsCollectorStatus {
	return {
		state: "running",
		error: null,
		stoppedSince: null,
		intervalMinutes: 15,
		lastRunAt: null,
		nextRunAt: null,
		sources: [],
		...over,
	};
}

/** 採点が動いていて、v1 を使っている状態 */
export function scorerStatus(over: Partial<ScorerStatus> = {}): ScorerStatus {
	return {
		state: "running",
		error: null,
		stoppedSince: null,
		model: "gemini-3.5-flash-lite",
		activeCriteriaVersion: 1,
		pending: 0,
		rescorePending: 0,
		...over,
	};
}

/** 採点済み（v1）の点数 */
export function newsScore(over: Partial<NewsScore> = {}): NewsScore {
	return {
		status: "done",
		scores: { sentiment: 30, risk: 10 },
		duration: "short",
		instruments: {},
		comment: "採点の理由。",
		scoredAt: 0,
		rescoredAt: null,
		criteriaVersion: 1,
		model: "gemini-3.5-flash-lite",
		appBuiltAt: null,
		error: null,
		nextAttemptAt: null,
		...over,
	};
}

/** 未採点の記事。score を渡すと採点済みなどにできる */
export function newsItem(
	over: Partial<NewsItem> & Pick<NewsItem, "id" | "title">,
): NewsItem {
	return {
		sourceId: 1,
		sourceName: "取得元",
		language: "ja",
		url: `https://news.example/articles/${over.id}`,
		summary: null,
		publishedAt: 0,
		fetchedAt: over.publishedAt ?? 0,
		score: null,
		rescore: null,
		...over,
	};
}

/** 採点済みの記事から、backend と同じ計算（core）で時刻 time の市場評価を作る */
export function currentJudgment(
	news: readonly NewsItem[],
	time: number,
	rule: AggregationRule = DEFAULT_AGGREGATION_RULE,
): CurrentJudgment {
	const scored: ScoredNews[] = news.flatMap((n) =>
		n.score?.status === "done" && n.score.scores && n.score.duration
			? [
					{
						id: n.id,
						publishedAt: n.publishedAt,
						fetchedAt: n.fetchedAt,
						usableAt: n.score.scoredAt ?? n.fetchedAt,
						scores: n.score.scores,
						duration: n.score.duration,
					},
				]
			: [],
	);
	const s = judgeAt(scored, time, rule);
	return {
		time,
		rule,
		results: s.results,
		weights: Object.fromEntries(s.weights),
		breakdown: judgmentBreakdown(scored, s.weights, rule),
		firstScoredAt: scored.length
			? Math.min(...scored.map((n) => n.usableAt))
			: null,
	};
}

/**
 * 観点ごとの精度の集計。byPrecision は精度 5〜1 の順に、記事の段階（JUDGMENT_VALUES の並び）ごとの件数。
 * moves は記事の段階ごとの値動きの段階 0〜4 の件数。省いた分は 0 件
 */
export function accuracyResult<J extends Judge>(
	judge: J,
	byPrecision: number[][] = [],
	moves: Partial<Record<string, number[]>> = {},
): AccuracySummaryResult<J> {
	const values = JUDGMENT_VALUES[
		judge
	] as readonly AccuracySummaryResult<J>["matrix"][number]["value"][];
	const rows = [5, 4, 3, 2, 1].map((precision, i) => {
		const counts = byPrecision[i] ?? [];
		return {
			precision,
			count: counts.reduce((a, b) => a + b, 0),
			levels: values.map((value, k) => ({ value, count: counts[k] ?? 0 })),
		};
	});
	return {
		count: rows.reduce((a, r) => a + r.count, 0),
		rows,
		matrix: values.map((value) => ({
			value,
			moves: moves[value] ?? [0, 0, 0, 0, 0],
		})),
	};
}

/** 直近30日・24h で、精度を出せた記事が無い集計 */
export function accuracySummary(
	over: Partial<AccuracySummary> = {},
): AccuracySummary {
	return {
		horizon: "24h",
		periodDays: 30,
		time: 0,
		filter: { criteriaVersion: null, appBuiltAt: null, model: null },
		options: {
			criteriaVersions: [],
			appBuiltAts: [],
			models: [],
			activeCriteriaVersion: 1,
			activeModel: "gemini-3.5-flash-lite",
		},
		results: {
			sentiment: accuracyResult("sentiment"),
			risk: accuracyResult("risk"),
		},
		...over,
	};
}

export function importJob(
	over: Partial<ImportJob> & Pick<ImportJob, "id">,
): ImportJob {
	return {
		timeframe: "1m",
		fileName: "btc.csv",
		status: "running",
		phase: "validating",
		processedRows: 0,
		totalRows: 0,
		insertedRows: 0,
		skippedRows: 0,
		derivedRows: 0,
		startedAt: Date.UTC(2026, 8, 1),
		finishedAt: null,
		firstTime: null,
		lastTime: null,
		overlap: null,
		overwrite: null,
		message: null,
		errors: [],
		errorCount: 0,
		...over,
	};
}

export function coverage(
	over: Partial<TimeframeCoverage> &
		Pick<TimeframeCoverage, "timeframe" | "count" | "firstTime" | "lastTime">,
): TimeframeCoverage {
	return {
		importedCount: over.count,
		gaps: [],
		gapCount: 0,
		...over,
	};
}

export function backtestRun(
	over: Partial<BacktestRun> & Pick<BacktestRun, "id" | "name">,
): BacktestRun {
	return {
		instrument: BTC_JPY,
		instruments: [BTC_JPY],
		params: strategyTemplate("blank").params,
		timeframe: "1h",
		from: Date.UTC(2026, 7, 31, 15),
		to: Date.UTC(2026, 8, 30, 15),
		initialCash: 1_000_000,
		fees: COINCHECK_EXCHANGE.fees,
		skipGaps: false,
		stepTimeframe: "1h",
		stepLimited: false,
		status: "done",
		progress: 1,
		startedAt: Date.UTC(2026, 9, 1),
		finishedAt: Date.UTC(2026, 9, 1, 0, 1),
		barCount: 720,
		summary: null,
		filledCount: 0,
		orderCount: 0,
		error: null,
		aggregationRule: null,
		criteriaVersion: null,
		eventCriteriaVersion: null,
		newsDelayMs: null,
		newsDataVersion: null,
		segment: null,
		datasetRunId: null,
		dailyLossLimitApplied: true,
		...over,
	};
}

export function timeframeCoverage(
	timeframe: Timeframe,
	from: number,
	to: number,
	over: Partial<TimeframeCoverage> = {},
): TimeframeCoverage {
	const step = TIMEFRAME_MS[timeframe];
	const count = Math.floor((to - from) / step);
	return {
		timeframe,
		count,
		importedCount: count,
		firstTime: from,
		lastTime: from + (count - 1) * step,
		gaps: [],
		gapCount: 0,
		...over,
	};
}

export function storedStrategy(
	over: Partial<StoredStrategy> & Pick<StoredStrategy, "id" | "name">,
): StoredStrategy {
	return {
		market: "coincheck",
		instruments: ["coincheck:btc_jpy"],
		params: strategyTemplate("blank").params,
		createdAt: 0,
		updatedAt: 0,
		...over,
	};
}

type Bars = Extract<
	InferResponseType<ApiClient["api"]["market"]["bars"]["$get"]>,
	{ bars: unknown }
>["bars"];

export function chartBars(
	timeframe: Timeframe,
	now: number,
	count = 120,
	base = 10_000_000,
): Bars {
	const last = candleStart(now, timeframe, COINCHECK.calendar);
	return Array.from({ length: count }, (_, i) => {
		const close = base + Math.round(Math.sin(i / 5) * 100_000) + i * 1_000;
		return {
			time: last - (count - 1 - i) * TIMEFRAME_MS[timeframe],
			open: close - 20_000,
			high: close + 50_000,
			low: close - 50_000,
			close,
			volume: 50_000_000,
		};
	});
}

export function tradingPerformance(
	over: Partial<TradingPerformance> = {},
): TradingPerformance {
	return {
		resetAt: 0,
		initialCash: 1_000_000,
		cash: 1_000_000,
		position: { quantity: 0, entryPrice: null, openedAt: null },
		price: null,
		equity: 1_000_000,
		pnl: 0,
		pnlPercent: 0,
		buyHoldPercent: null,
		realizedPnl: 0,
		trades: 0,
		wins: 0,
		losses: 0,
		winRate: null,
		profitFactor: null,
		maxDrawdownPercent: 0,
		maxDrawdownFrom: null,
		maxDrawdownTo: null,
		averageHoldingMs: null,
		...over,
	};
}

export function storedOrder(
	over: Partial<StoredOrder> & Pick<StoredOrder, "id">,
): StoredOrder {
	return {
		instrument: BTC_JPY.id,
		side: "buy",
		type: "market",
		price: null,
		quantity: 2_000_000,
		placedAt: 0,
		status: "filled",
		filledAt: 0,
		fillPrice: 10_000_000,
		fee: 0,
		canceledAt: null,
		cancelReason: null,
		reason: "買いの条件が成立",
		pairId: null,
		pnl: null,
		runId: 1,
		mode: "paper",
		decisionId: null,
		strategyId: null,
		strategyName: "",
		lotPrice: null,
		exitKind: null,
		...over,
	};
}

export function judgmentSeries(
	from: number,
	to: number,
	step: number,
): JudgmentSeries {
	const n = Math.max(0, Math.ceil((to - from) / step));
	return {
		from,
		step,
		firstScoredAt: from,
		values: {
			sentiment: Array.from({ length: n }, () => "+1" as const),
			risk: Array.from({ length: n }, () => "mild" as const),
		},
	};
}

/** ひな形の条件で保存済みの戦略 */
export function templateStrategy(
	id: number,
	name: string,
	template: TemplateId = "trend",
	params: ConditionSet = strategyTemplate(template).params,
): StoredStrategy {
	return storedStrategy({ id, name, params });
}

/** センチメントは中立、リスクは平常の市場評価（記事1件ぶん） */
export function neutralJudgment(time: number): CurrentJudgment {
	const result = { average: 0, count: 1 };
	return {
		time,
		rule: DEFAULT_AGGREGATION_RULE,
		results: {
			sentiment: { value: "0", ...result },
			risk: { value: "calm", ...result },
		},
		weights: {},
		breakdown: { sentiment: [], risk: [] },
		firstScoredAt: 0,
	};
}
