// 偽物の API が返す値のひな形。テストで変えたいところだけ上書きする
import type {
	AccuracySummary,
	AccuracySummaryResult,
	AutoTradingStatus,
	BacktestRun,
	CurrentJudgment,
	ImportJob,
	NewsCollectorStatus,
	NewsItem,
	NewsScore,
	NewsSource,
	ScorerStatus,
	StoredStrategy,
	TimeframeCoverage,
} from "@trading-studio/backend";
import type {
	AggregationRule,
	Judge,
	ScoredNews,
	Timeframe,
} from "@trading-studio/core";
import {
	DEFAULT_AGGREGATION_RULE,
	DEFAULT_FEE_RATES,
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
		enabled: false,
		mode: "paper",
		strategy: null,
		nextEvalAt: null,
		startedAt: null,
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
		params: strategyTemplate("blank").params,
		timeframe: "1h",
		from: Date.UTC(2026, 7, 31, 15),
		to: Date.UTC(2026, 8, 30, 15),
		initialCash: 1_000_000,
		fees: DEFAULT_FEE_RATES,
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
		params: strategyTemplate("blank").params,
		createdAt: 0,
		updatedAt: 0,
		...over,
	};
}
