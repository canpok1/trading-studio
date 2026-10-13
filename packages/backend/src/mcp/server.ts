// ローカルの Claude Code から戦略とニュースの採点を相談するための MCP（Streamable HTTP）。docs/mcp.md
// 自動取引のオンオフ・運用する戦略の切替と変更・削除・設定は道具にしない（画面から人が行う）。運用の結果は読める。
// 例外は採点の基準の版の保存と切替（docs/adr/0013）

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type {
	ConditionSet,
	GradeBadgeValue,
	Judge,
	JudgeResult,
	JudgmentValue,
	MarketRegime,
	Position,
	StrategyWatch,
	Timeframe,
	WatchAction,
	WatchGroup,
} from "@trading-studio/core";
import {
	conditionScreenText,
	conditionSetScreenText,
	DEFAULT_FEE_RATES,
	DURATIONS,
	fewTradesNote,
	gradeMaxDrawdown,
	gradePnl,
	gradeProfitFactor,
	gradeWinRate,
	JUDGES,
	JUDGMENT_VALUE_LABELS,
	JUDGMENT_VALUES,
	LIVE_AVAILABLE,
	MARKET_REGIME_LABELS,
	MARKET_REGIMES,
	nextMoves,
	parseAggregationRule,
	parseConditionSet,
	TIMEFRAME_MS,
	TIMEFRAMES,
	unrealizedPnl,
	validateAggregationRule,
} from "@trading-studio/core";
import { Hono } from "hono";
import * as z from "zod";
import type { AdviceService } from "../advice/types-domain";
import type {
	BacktestRun,
	BacktestService,
	StartBacktestFailure,
} from "../backtests/types-domain";
import type {
	Dataset,
	DatasetRun,
	DatasetRunDetail,
	DatasetService,
	StartDatasetFailure,
} from "../datasets/types-domain";
import type { JudgmentService } from "../judgments/types-domain";
import type { MarketService } from "../market/types-domain";
import type { MarketDataService } from "../market-data/types-domain";
import type { NewsItem, NewsService, ScoringService } from "../news/types";
import {
	NEWS_IMPACTS,
	NEWS_LIST_MAX,
	NEWS_SORTS,
	TRIAL_MAX_NEWS,
} from "../news/types";
import { MOVE_LABELS } from "../scoring-analysis/accuracy";
import type {
	AccuracyService,
	AccuracySummaryResult,
	ArticleAccuracy,
} from "../scoring-analysis/types";
import type { SegmentService } from "../segments/types-domain";
import type {
	StoredStrategy,
	StrategyService,
} from "../strategies/types-domain";
import type {
	AutoTradingStatus,
	StoredOrder,
	TradingPerformance,
	TradingService,
} from "../trading/types";
import { conditionSetGuide } from "./guide";

export type McpDeps = {
	strategies: StrategyService;
	backtests: BacktestService;
	marketData: MarketDataService;
	segments: SegmentService;
	/** データセット（画面の呼び名。相場データを束ねたもの） */
	datasets: DatasetService;
	scoring: ScoringService;
	news: Pick<NewsService, "searchNews">;
	judgments: Pick<JudgmentService, "rule" | "current" | "series">;
	accuracy: AccuracyService;
	/** ホームのタブ（運用）。読むだけで、オンオフや戦略の切替は道具にしない */
	trading: Pick<
		TradingService,
		| "runs"
		| "run"
		| "performance"
		| "watch"
		| "orders"
		| "orderSummary"
		| "order"
	>;
	market: Pick<MarketService, "latest" | "bars">;
	advice: Pick<AdviceService, "get">;
	/** ホームのタブのどれかが運用する戦略に選んでいるか。選ばれている戦略は条件を変えさせない */
	inUse: (strategyId: number) => boolean;
	/** run_backtest が終わりを待つ時間。過ぎたら実行中のまま返し、get_backtest で続きを見てもらう */
	backtestWaitMs?: number;
	sleep?: (ms: number) => Promise<void>;
};

/** run_backtest が終わりを待つ時間の既定。HTTP の無通信の切断はこれより長くする（main.ts） */
export const BACKTEST_WAIT_MS = 120_000;

const JST_OFFSET_MS = 9 * 3_600_000;

/** エポックミリ秒を JST の ISO 8601 にする */
export const jst = (ms: number) =>
	new Date(ms + JST_OFFSET_MS).toISOString().replace(/(\.000)?Z$/, "+09:00");

/** ISO 8601（タイムゾーン付き）か YYYY-MM-DD（JST の 0:00）をエポックミリ秒にする。読めなければ null */
export function parseTime(s: string): number | null {
	if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
		const t = Date.parse(`${s}T00:00:00+09:00`);
		return Number.isNaN(t) ? null : t;
	}
	// タイムゾーンの無い日時は実行環境の TZ で読まれてしまうので受け付けない
	if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) return null;
	const t = Date.parse(s);
	return Number.isNaN(t) ? null : t;
}

const text = (v: unknown) => ({
	content: [
		{
			type: "text" as const,
			text: typeof v === "string" ? v : JSON.stringify(v, null, 2),
		},
	],
});
const fail = (message: string, detail?: unknown) => ({
	...text(detail === undefined ? { message } : { message, detail }),
	isError: true,
});

const paramsSchema = z
	.record(z.string(), z.unknown())
	.describe("条件セット。形は get_guide を参照");

function strategyView(s: StoredStrategy, inUse: (id: number) => boolean) {
	return {
		id: s.id,
		name: s.name,
		active: inUse(s.id),
		updatedAt: jst(s.updatedAt),
		screenText: conditionSetScreenText(s.params).join("\n"),
		params: s.params,
	};
}

const gradeLabel = (g: GradeBadgeValue | null) => g?.label ?? null;

/** 画面の成績の横に出す5段階の評価と、取引が少ないときの注意。損益はガチホと比べるので、ガチホが分からなければ null */
function grades(s: {
	pnlPercent: number | null;
	buyHoldPercent: number | null;
	idle: boolean;
	winRate: number | null;
	profitFactor: number | null;
	trades: number;
	maxDrawdownPercent: number;
}) {
	return {
		pnl: gradeLabel(gradePnl(s.pnlPercent, s.buyHoldPercent, s.idle)),
		winRate: gradeLabel(gradeWinRate(s.winRate)),
		profitFactor: gradeLabel(gradeProfitFactor(s.profitFactor, s.trades)),
		maxDrawdown: gradeMaxDrawdown(s.maxDrawdownPercent).label,
		note: fewTradesNote(s.trades),
	};
}

function runView(r: BacktestRun) {
	const s = r.summary;
	return {
		id: r.id,
		name: r.name,
		status: r.status,
		progress: r.progress,
		from: jst(r.from),
		to: jst(r.to),
		stepTimeframe: r.stepTimeframe,
		stepLimited: r.stepLimited,
		initialCash: r.initialCash,
		fees: r.fees,
		criteriaVersion: r.criteriaVersion,
		// 記事を公開から何分後に使ったか。市場評価の条件が無い・公開時刻から使う前の実行は null
		newsDelayMinutes:
			r.newsDelayMs === null ? null : Math.round(r.newsDelayMs / 60_000),
		// 使ったニュースのデータの版。違えば使ったニュースが違う
		newsDataVersion: r.newsDataVersion === null ? null : jst(r.newsDataVersion),
		// 期間を相場データで選んだときの相場データと、そのときの相場
		segment: r.segment && {
			id: r.segment.id,
			regime: MARKET_REGIME_LABELS[r.segment.regime],
		},
		// データセット（相場データを束ねたもの）でまとめて実行したときの、まとめた実行（get_dataset_run）
		datasetRunId: r.datasetRunId,
		startedAt: jst(r.startedAt),
		summary: s && {
			...s,
			maxDrawdownFrom:
				s.maxDrawdownFrom === null ? null : jst(s.maxDrawdownFrom),
			maxDrawdownTo: s.maxDrawdownTo === null ? null : jst(s.maxDrawdownTo),
			averageHoldingHours:
				s.averageHoldingMs === null
					? null
					: Math.round((s.averageHoldingMs / 3_600_000) * 10) / 10,
			// ガチホを持たない古い実行は損益の評価が null（画面はチャートの足から求める）
			grades: grades({
				...s,
				buyHoldPercent: s.buyHoldPercent ?? null,
				idle: s.trades === 0 && s.openPositionQuantity === 0,
			}),
		},
		orderCount: r.orderCount,
		filledCount: r.filledCount,
		error: r.error,
	};
}

function startFailure(e: StartBacktestFailure) {
	switch (e.kind) {
		case "busy":
			return fail(
				"別のバックテストを実行中。get_backtest で終わりを待ってから実行する",
				{ running: runView(e.run) },
			);
		case "invalid_params":
			return fail("条件に入力の誤りがある", e.errors);
		case "invalid_input":
			return fail(e.message, { field: e.field });
		case "no_data":
			return fail(e.message);
		case "no_judgments":
			return fail(e.message, {
				firstScoredAt: e.firstScoredAt === null ? null : jst(e.firstScoredAt),
			});
		case "missing_scores":
			return fail(
				`${e.message}。rescore_news で採点し直し、終わってから実行する`,
				{ coverage: e.coverage },
			);
		case "gaps":
			return fail(
				"期間内にデータの欠損がある。承知で進めるなら skipGaps: true で実行し直す",
				{
					gapCount: e.gapCount,
					missingBars: e.missingBars,
					gaps: e.gaps.slice(0, 10).map((g) => ({
						from: jst(g.from),
						to: jst(g.to),
					})),
				},
			);
	}
}

function datasetView(s: Dataset) {
	return {
		id: s.id,
		name: s.name,
		segments: s.segments.map((d) => ({
			id: d.id,
			from: jst(d.from),
			to: jst(d.to),
			regime: MARKET_REGIME_LABELS[d.regime],
		})),
		// 保存した後に消えた相場データの数
		missing: s.missing,
	};
}

function datasetRunView(r: DatasetRun | DatasetRunDetail) {
	return {
		id: r.id,
		name: r.name,
		dataset: { id: r.datasetId, name: r.datasetName },
		status: r.status,
		progress: r.progress,
		initialCash: r.initialCash,
		fees: r.fees,
		criteriaVersion: r.criteriaVersion,
		startedAt: jst(r.startedAt),
		// 全取引をまとめた勝率・PF、損益率の平均・最悪、最大DDの最大、ガチホ以上だった件数、相場ごとの平均
		summary: r.summary && {
			...r.summary,
			byRegime: r.summary.byRegime.map((x) => ({
				...x,
				regime: MARKET_REGIME_LABELS[x.regime],
			})),
			// 損益の評価は損益率の平均をガチホの平均と比べる（画面の「損益の平均」）
			grades: grades({
				...r.summary,
				pnlPercent: r.summary.averagePnlPercent,
				buyHoldPercent: r.summary.averageBuyHoldPercent,
			}),
		},
		error: r.error,
		runs: "runs" in r ? r.runs.map(runView) : undefined,
	};
}

function datasetFailure(e: StartDatasetFailure) {
	switch (e.kind) {
		case "busy":
		case "not_found":
		case "empty":
			return fail(e.message);
		case "invalid_params":
			return fail("条件に入力の誤りがある", e.errors);
		case "invalid_input":
			return fail(e.message, { field: e.field });
		case "blocked":
			return fail(
				"実行できない相場データがあるため、全体を実行しない。欠損だけなら skipGaps: true で実行し直す",
				e.blockers.map((b) => ({
					segment: {
						id: b.segment.id,
						from: jst(b.segment.from),
						to: jst(b.segment.to),
						regime: MARKET_REGIME_LABELS[b.segment.regime],
					},
					kind: b.error.kind,
					message:
						"message" in b.error
							? b.error.message
							: "期間内にデータの欠損がある",
				})),
			);
	}
}

/** 画面と同じ評価の日本語名を添える */
const level = <J extends Judge>(value: JudgmentValue<J>) => ({
	value,
	label: JUDGMENT_VALUE_LABELS[value] ?? value,
});

const ratio = (v: number) => Math.round(v * 1000) / 1000;

function newsView(
	n: NewsItem,
	weight: number | undefined,
	accuracy: ArticleAccuracy | undefined,
) {
	const s = n.score;
	const done = s?.status === "done";
	return {
		id: n.id,
		source: n.sourceName,
		language: n.language,
		title: n.title,
		summary: n.summary,
		url: n.url,
		publishedAt: jst(n.publishedAt),
		fetchedAt: jst(n.fetchedAt),
		status: s?.status ?? "unscored",
		scores: done ? s.scores : null,
		duration: done ? s.duration : null,
		comment: s?.comment ?? null,
		scoredAt: s?.scoredAt == null ? null : jst(s.scoredAt),
		rescoredAt: s?.rescoredAt == null ? null : jst(s.rescoredAt),
		criteriaVersion: s?.criteriaVersion ?? null,
		model: s?.model ?? null,
		appVersion: s?.appBuiltAt == null ? null : jst(s.appBuiltAt),
		error: s?.error ?? null,
		nextAttemptAt: s?.nextAttemptAt == null ? null : jst(s.nextAttemptAt),
		weight: done ? ratio(weight ?? 0) : null,
		precision:
			accuracy === undefined
				? null
				: accuracy.status === "ok"
					? { sentiment: accuracy.sentiment, risk: accuracy.risk }
					: accuracy.status,
		rescore: n.rescore && {
			...n.rescore,
			nextAttemptAt:
				n.rescore.nextAttemptAt === null ? null : jst(n.rescore.nextAttemptAt),
		},
	};
}

/** 時点の入力。省けば今。読めなければエラーの応答 */
function atTime(at: string | undefined) {
	if (at === undefined) return { at: undefined };
	const t = parseTime(at);
	return t === null
		? fail("at はタイムゾーン付きの ISO 8601 か YYYY-MM-DD で書く")
		: { at: t };
}

const atSchema = z
	.string()
	.optional()
	.describe(
		"市場評価の時点。ISO 8601（タイムゾーン付き）か YYYY-MM-DD（JST の 0:00）。省けば今",
	);

/** 市場評価の分析の観点1つ。画面の 精度ごと・評価ごと・評価×値動き と同じ数 */
function analysisView<J extends Judge>(j: J, r: AccuracySummaryResult<J>) {
	const values = JUDGMENT_VALUES[j] as readonly JudgmentValue<J>[];
	return {
		count: r.count,
		byPrecision: r.rows.map((row) => ({
			precision: row.precision,
			count: row.count,
			byLevel: row.levels.map((l) => ({ ...level(l.value), count: l.count })),
		})),
		byLevel: values.map((value) => {
			const counts = r.rows.map((row) => ({
				precision: row.precision,
				count: row.levels.find((l) => l.value === value)?.count ?? 0,
			}));
			const n = counts.reduce((a, x) => a + x.count, 0);
			return {
				...level(value),
				count: n,
				byPrecision: counts,
			};
		}),
		byLevelAndMove: r.matrix.map((m) => ({
			...level(m.value),
			moves: m.moves.map((count, i) => ({ move: MOVE_LABELS[j][i], count })),
		})),
	};
}

/** get_price_bars で一度に返す足の上限 */
const BARS_MAX = 2_000;

const MODE_LABELS = { paper: "デモ", live: "リアル" } as const;

/** 口座・成績・注文・戦略の見張りを出さないタブ。画面と同じく、動かせないリアル */
const hidden = (r: AutoTradingStatus) => r.mode === "live" && !LIVE_AVAILABLE;

function positionView(p: Position) {
	return { ...p, openedAt: p.openedAt === null ? null : jst(p.openedAt) };
}

function tradingPerformanceView(p: TradingPerformance) {
	return {
		...p,
		resetAt: jst(p.resetAt),
		position: positionView(p.position),
		maxDrawdownFrom: p.maxDrawdownFrom === null ? null : jst(p.maxDrawdownFrom),
		maxDrawdownTo: p.maxDrawdownTo === null ? null : jst(p.maxDrawdownTo),
		averageHoldingHours:
			p.averageHoldingMs === null
				? null
				: Math.round((p.averageHoldingMs / 3_600_000) * 10) / 10,
		grades: grades({
			...p,
			idle: p.trades === 0 && p.position.quantity === 0,
		}),
	};
}

function tradingRunView(r: AutoTradingStatus) {
	return {
		id: r.id,
		name: r.name,
		mode: r.mode,
		modeLabel: MODE_LABELS[r.mode],
		enabled: r.enabled,
		strategy: r.strategy,
		nextEvalAt: r.nextEvalAt === null ? null : jst(r.nextEvalAt),
		startedAt: r.startedAt === null ? null : jst(r.startedAt),
		waitingForMarket: r.waitingForMarket,
		dailyLoss: r.dailyLoss,
	};
}

/** デモのタブの口座・含み損益・成績。リアルは画面と同じく出さない */
function paperView(
	r: AutoTradingStatus,
	price: number | null,
	performance: TradingPerformance | null,
) {
	const a = r.account;
	return {
		account: {
			initialCash: a.initialCash,
			cash: a.cash,
			equity: a.equity,
			position: positionView(a.position),
			lots: a.lots.map((l) => ({
				...l,
				openedAt: jst(l.openedAt),
				unrealizedPnl: unrealizedPnl(l.quantity, l.entryPrice, price),
			})),
			openOrderCount: a.openOrderCount,
			resetAt: jst(a.resetAt),
		},
		unrealizedPnl: unrealizedPnl(
			a.position.quantity,
			a.position.entryPrice,
			price,
		),
		performance: performance && tradingPerformanceView(performance),
	};
}

function tradingOrderView(o: StoredOrder) {
	return {
		id: o.id,
		side: o.side,
		type: o.type,
		price: o.price,
		quantity: o.quantity,
		status: o.status,
		placedAt: jst(o.placedAt),
		filledAt: o.filledAt === null ? null : jst(o.filledAt),
		fillPrice: o.fillPrice,
		fee: o.fee,
		canceledAt: o.canceledAt === null ? null : jst(o.canceledAt),
		cancelReason: o.cancelReason,
		reason: o.reason,
		pnl: o.pnl,
		lotPrice: o.lotPrice,
		exitKind: o.exitKind,
		buyName: o.buyName ?? null,
		strategyName: o.strategyName,
	};
}

/** 発注したときの市場評価。判断の記録が無ければ null、採点の記録の前は空 */
function judgmentsView(j: Record<string, string> | undefined) {
	if (!j) return null;
	return Object.fromEntries(
		JUDGES.filter((k) => j[k] !== undefined).map((k) => [
			k,
			level(j[k] as JudgmentValue<typeof k>),
		]),
	);
}

/** 条件は画面の文言にする */
function watchGroupView(g: WatchGroup) {
	return {
		match: g.match,
		met: g.met,
		triggers: g.triggers,
		conditions: g.conditions.map((c) => ({
			text: conditionScreenText(c.condition),
			met: c.met,
			detail: c.detail,
			edge: c.edge,
		})),
	};
}

function watchView(w: StrategyWatch) {
	const action = (a: WatchAction) => ({
		...a,
		distancePercent:
			a.price === null
				? null
				: Math.round((a.price / w.price - 1) * 10_000) / 100,
	});
	const next = nextMoves(w);
	return {
		price: w.price,
		nextMoves: {
			now: next.now.map(action),
			up: next.up && action(next.up),
			down: next.down && action(next.down),
		},
		actions: w.actions.map(action),
		buys: w.buys.map((b) => ({
			...b,
			buy: watchGroupView(b.buy),
			lots: b.lots.map((l) => ({
				...l,
				groups:
					l.groups &&
					Object.fromEntries(
						Object.entries(l.groups).map(([k, g]) => [
							k,
							g && watchGroupView(g),
						]),
					),
			})),
		})),
	};
}

function createServer({
	strategies,
	backtests,
	marketData,
	segments,
	datasets,
	scoring,
	news,
	judgments,
	accuracy,
	trading,
	market,
	advice,
	inUse,
	backtestWaitMs = BACKTEST_WAIT_MS,
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}: McpDeps) {
	const server = new McpServer(
		{ name: "trading-studio", version: "1.0.0" },
		{
			instructions:
				"BTC/JPY の自動売買アプリ trading-studio。戦略の条件と、ニュースの AI 採点の基準を相談して改良するための道具。戦略: まず get_guide で条件セットの書き方を読む。戦略の新規作成・運用中でない戦略の条件変更・バックテストの実行ができる。自動取引のオンオフや運用する戦略の切替・変更はできない（画面で人が行う）。運用の結果は list_trading_runs・list_trading_orders・get_strategy_watch、価格は get_market_price・get_price_bars で読める。採点: get_scoring_setup で仕組みと今の基準を読み、get_market_evaluation で市場評価とその内訳を、get_market_evaluation_analysis で採点がその後の値動きと合っていたか（精度）の集計を、list_news_scores で記事ごとの採点と精度を見て、trial_scoring で基準の案を過去のニュースに試し、add_scoring_criteria で版として保存し、rescore_news と run_backtest の criteriaVersion でその版の成績を確かめ、set_active_scoring_criteria で使い始める。切り替えると次に採点するニュースから効き、自動取引の判定にも効くので、切り替える前に利用者に確認を取る。",
		},
	);
	const readOnly = { readOnlyHint: true, openWorldHint: false };

	server.registerTool(
		"get_guide",
		{
			description:
				"条件セット（戦略の params）の項目・単位・範囲と、ひな形の例を返す",
			annotations: readOnly,
		},
		() => text(conditionSetGuide()),
	);

	server.registerTool(
		"list_strategies",
		{
			description:
				"保存済みの戦略の一覧。active はホームのタブのどれかが運用する戦略（自動取引で使う）に選んでいる戦略で、条件を変えられない",
			annotations: readOnly,
		},
		() => {
			return text(
				strategies.list().map((s) => {
					const { params: _, ...rest } = strategyView(s, inUse);
					return rest;
				}),
			);
		},
	);

	server.registerTool(
		"get_strategy",
		{
			description: "戦略1つの条件（画面の文言と params）",
			inputSchema: { id: z.number().int() },
			annotations: readOnly,
		},
		({ id }) => {
			const s = strategies.get(id);
			return s ? text(strategyView(s, inUse)) : fail("戦略が見つからない");
		},
	);

	server.registerTool(
		"create_strategy",
		{
			description:
				"条件セットから新しい戦略を保存する。名前は 1〜40 文字で既存と重複できない",
			inputSchema: { name: z.string(), params: paramsSchema },
			annotations: { destructiveHint: false, openWorldHint: false },
		},
		({ name, params }) => {
			const p = parseConditionSet(params);
			if (!p) return fail("条件セットの形が違う。get_guide を参照");
			const r = strategies.create({ name, from: { params: p } });
			if (!r.ok) return strategyFailure(r.error);
			return text(strategyView(r.strategy, inUse));
		},
	);

	server.registerTool(
		"update_strategy",
		{
			description:
				"戦略の条件を置き換える。運用する戦略（active）は変えられない。残したい元の条件があるなら create_strategy で別に作る",
			inputSchema: { id: z.number().int(), params: paramsSchema },
			annotations: {
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		({ id, params }) => {
			if (inUse(id)) {
				return fail(
					"運用する戦略は変えられない。create_strategy で新しい戦略として作る",
				);
			}
			const p = parseConditionSet(params);
			if (!p) return fail("条件セットの形が違う。get_guide を参照");
			const r = strategies.updateParams(id, p);
			if (!r.ok) return strategyFailure(r.error);
			return text(strategyView(r.strategy, inUse));
		},
	);

	server.registerTool(
		"get_data_coverage",
		{
			description: "バックテストに使える価格データの粒度ごとの範囲と欠損の数",
			annotations: readOnly,
		},
		() =>
			text(
				marketData.coverage().map((c) => ({
					timeframe: c.timeframe,
					count: c.count,
					first: c.firstTime === null ? null : jst(c.firstTime),
					last: c.lastTime === null ? null : jst(c.lastTime),
					gapCount: c.gaps.length,
				})),
			),
	);

	server.registerTool(
		"list_segments",
		{
			description:
				"相場データ（画面の呼び名。コード上の名前は segment）の一覧（新しい順）。毎月、直近2か月の期間に相場のラベル（上昇・下落・レンジ・乱高下）を1つ付けて作る。run_backtest の segmentId に渡すとその期間で実行する。returnPercent は期間の騰落率、volatilityPercent は日ごとの騰落率の標準偏差",
			inputSchema: {
				regime: z
					.enum(MARKET_REGIMES as [MarketRegime, ...MarketRegime[]])
					.optional()
					.describe(
						"相場で絞る。up=上昇・down=下落・range=レンジ・volatile=乱高下",
					),
			},
			annotations: readOnly,
		},
		({ regime }) =>
			text(
				segments.list(regime ?? null).map((d) => ({
					id: d.id,
					from: jst(d.from),
					to: jst(d.to),
					regime: d.regime,
					label: MARKET_REGIME_LABELS[d.regime],
					returnPercent: d.returnPpm / 10_000,
					volatilityPercent: d.volatilityPpm / 10_000,
				})),
			),
	);

	server.registerTool(
		"list_backtests",
		{
			description:
				"バックテストの履歴（画面の履歴のタブと同じ）。単独の実行（kind: run）と、データセットでまとめた実行（kind: dataset。中身は get_dataset_run）を1行ずつ並べる。まとめた実行に含まれる実行は出さない。total は絞り込みに合う件数",
			inputSchema: {
				limit: z.number().int().min(1).max(100).default(20),
				q: z
					.string()
					.default("")
					.describe("名前のキーワード。空白で区切った語をすべて含むもの"),
				hideFailed: z.boolean().default(false).describe("失敗・中止を除く"),
				sort: z
					.enum(["new", "pnl"])
					.default("new")
					.describe(
						"new=実行の新しい順、pnl=損益率の高い順（まとめた実行は損益率の平均。成績の無いものは最後）",
					),
			},
			annotations: readOnly,
		},
		({ limit, q, hideFailed, sort }) => {
			const r = datasets.history({ limit, q, hideFailed, sort });
			return text({
				total: r.total,
				entries: r.entries.map((e) =>
					e.kind === "run"
						? { kind: e.kind, ...runView(e.run) }
						: { kind: e.kind, ...datasetRunView(e.datasetRun) },
				),
			});
		},
	);

	server.registerTool(
		"get_backtest_advice",
		{
			description:
				"バックテストの結果画面の AI アドバイス（結果の分析・うまくいった点・悪かった点・改善案・改善案を反映した条件セット）と、作った時刻・モデル・指示の版。作るのは画面から（API の料金がかかるため道具にしない）。まだ無ければ null",
			inputSchema: { id: z.number().int().describe("バックテストの id") },
			annotations: readOnly,
		},
		({ id }) => {
			const a = advice.get(id);
			if (!a) return text(null);
			return text({
				status: a.status,
				content: a.content,
				model: a.model,
				instructionsVersion: a.instructionsVersion,
				appVersion: a.appBuiltAt === null ? null : jst(a.appBuiltAt),
				startedAt: jst(a.startedAt),
				finishedAt: a.finishedAt === null ? null : jst(a.finishedAt),
				error: a.error,
			});
		},
	);

	server.registerTool(
		"get_backtest",
		{
			description:
				"バックテスト1件の実行条件（戦略の条件を含む）と成績。実行中なら進み具合",
			inputSchema: { id: z.number().int() },
			annotations: readOnly,
		},
		({ id }) => {
			const r = backtests.get(id);
			if (!r) return fail("バックテストが見つからない");
			return text({
				...runView(r),
				screenText: conditionSetScreenText(r.params).join("\n"),
				params: r.params,
			});
		},
	);

	server.registerTool(
		"get_backtest_orders",
		{
			description:
				"バックテストの注文（新しい順）。発注の理由・約定・往復の損益（売りの pnl、手数料込み）を含む",
			inputSchema: {
				id: z.number().int(),
				filter: z.enum(["filled", "all"]).default("filled"),
				offset: z.number().int().min(0).default(0),
				limit: z.number().int().min(1).max(500).default(100),
			},
			annotations: readOnly,
		},
		({ id, filter, offset, limit }) => {
			const r = backtests.orders(id, filter, offset, limit);
			if (!r) return fail("バックテストの結果が見つからない");
			return text({
				total: r.total,
				orders: r.orders.map((o) => ({
					...o,
					placedAt: jst(o.placedAt),
					filledAt: o.filledAt === null ? null : jst(o.filledAt),
					canceledAt: o.canceledAt === null ? null : jst(o.canceledAt),
				})),
			});
		},
	);

	server.registerTool(
		"run_backtest",
		{
			description:
				"バックテストを実行し、終わるまで待って成績を返す。strategyId か params のどちらかで条件を渡す。期間は from・to か segmentId（相場データ）のどちらかで渡す。同時に実行できるのは1つ。待ちきれなければ実行中のまま返すので get_backtest で見る",
			inputSchema: {
				name: z.string().describe("バックテスト名（1〜40 文字）"),
				strategyId: z.number().int().optional(),
				params: paramsSchema.optional(),
				from: z
					.string()
					.optional()
					.describe("開始。ISO 8601（タイムゾーン付き）か YYYY-MM-DD（JST）"),
				to: z
					.string()
					.optional()
					.describe("終了（含まない）。書き方は from と同じ"),
				segmentId: z
					.number()
					.int()
					.optional()
					.describe("相場データ（list_segments）。渡すとその期間で実行する"),
				initialCash: z.number().int().default(2_000_000).describe("円"),
				limitFeePpm: z.number().int().default(DEFAULT_FEE_RATES.limitPpm),
				marketFeePpm: z.number().int().default(DEFAULT_FEE_RATES.marketPpm),
				skipGaps: z
					.boolean()
					.default(false)
					.describe("期間内の欠損を承知で実行する"),
				criteriaVersion: z
					.number()
					.int()
					.optional()
					.describe(
						"市場評価に使う採点の基準の版。省けば運用どおり（記事ごとに運用で採点した版）。指定すると期間の記事がすべてその版で採点されている必要がある（rescore_news）",
					),
			},
			annotations: { destructiveHint: false, openWorldHint: false },
		},
		async (a) => {
			let params: ConditionSet | null;
			if (a.strategyId !== undefined && a.params !== undefined) {
				return fail("strategyId と params はどちらか一方だけ渡す");
			}
			if (a.strategyId !== undefined) {
				params = strategies.get(a.strategyId)?.params ?? null;
				if (!params) return fail("戦略が見つからない");
			} else if (a.params !== undefined) {
				params = parseConditionSet(a.params);
				if (!params) return fail("条件セットの形が違う。get_guide を参照");
			} else {
				return fail("strategyId か params が必要");
			}
			const segmentId = a.segmentId ?? null;
			if (segmentId !== null && (a.from !== undefined || a.to !== undefined)) {
				return fail("from・to と segmentId はどちらか一方だけ渡す");
			}
			const from = segmentId !== null ? 0 : parseTime(a.from ?? "");
			const to = segmentId !== null ? 0 : parseTime(a.to ?? "");
			if (from === null || to === null) {
				return fail(
					"from・to はタイムゾーン付きの ISO 8601 か YYYY-MM-DD で書く。または相場データを segmentId で渡す",
				);
			}
			const started = backtests.start({
				name: a.name,
				params,
				from,
				to,
				initialCash: a.initialCash,
				fees: { limitPpm: a.limitFeePpm, marketPpm: a.marketFeePpm },
				skipGaps: a.skipGaps,
				criteriaVersion: a.criteriaVersion ?? null,
				segmentId,
			});
			if (!started.ok) return startFailure(started.error);
			const id = started.run.id;
			const deadline = Date.now() + backtestWaitMs;
			let run = backtests.get(id) ?? started.run;
			while (run.status === "running" && Date.now() < deadline) {
				await sleep(500);
				run = backtests.get(id) ?? run;
			}
			return text(runView(run));
		},
	);

	server.registerTool(
		"list_datasets",
		{
			description:
				"データセット（相場データを名前を付けて束ねたもの）の一覧。run_dataset でまとめて実行する",
			annotations: readOnly,
		},
		() => text(datasets.list().map(datasetView)),
	);

	server.registerTool(
		"save_dataset",
		{
			description:
				"データセット（相場データを束ねたもの）を保存する。id を渡すと上書き、省くと新しく作る。相場データは list_segments の id。期間が重なる相場データを入れると、重なった月の取引を2回数えるので成績が水増しされる",
			inputSchema: {
				id: z.number().int().optional(),
				name: z.string().describe("名前（1〜40 文字）"),
				segmentIds: z.array(z.number().int()).describe("相場データの id"),
			},
			annotations: { destructiveHint: false, openWorldHint: false },
		},
		({ id, name, segmentIds }) => {
			const r =
				id === undefined
					? datasets.create({ name, segmentIds })
					: datasets.update(id, { name, segmentIds });
			return r.ok ? text(datasetView(r.dataset)) : fail(r.message);
		},
	);

	server.registerTool(
		"run_dataset",
		{
			description:
				"データセット（相場データを束ねたもの）の相場データごとに、同じ条件でバックテストを1件ずつ順に実行し、終わるまで待って合算した成績とそれぞれの成績を返す。初期資金は相場データごとに戻す。実行できない相場データが1つでもあれば全体を実行しない。待ちきれなければ実行中のまま返すので get_dataset_run で見る",
			inputSchema: {
				datasetId: z.number().int().describe("データセット（list_datasets）"),
				name: z.string().describe("バックテスト名（1〜40 文字）"),
				strategyId: z.number().int().optional(),
				params: paramsSchema.optional(),
				initialCash: z.number().int().default(2_000_000).describe("円"),
				limitFeePpm: z.number().int().default(DEFAULT_FEE_RATES.limitPpm),
				marketFeePpm: z.number().int().default(DEFAULT_FEE_RATES.marketPpm),
				skipGaps: z
					.boolean()
					.default(false)
					.describe("期間内の欠損を承知で実行する"),
				criteriaVersion: z
					.number()
					.int()
					.optional()
					.describe("市場評価に使う採点の基準の版。run_backtest と同じ"),
			},
			annotations: { destructiveHint: false, openWorldHint: false },
		},
		async (a) => {
			let params: ConditionSet | null;
			if (a.strategyId !== undefined && a.params !== undefined) {
				return fail("strategyId と params はどちらか一方だけ渡す");
			}
			if (a.strategyId !== undefined) {
				params = strategies.get(a.strategyId)?.params ?? null;
				if (!params) return fail("戦略が見つからない");
			} else if (a.params !== undefined) {
				params = parseConditionSet(a.params);
				if (!params) return fail("条件セットの形が違う。get_guide を参照");
			} else {
				return fail("strategyId か params が必要");
			}
			const started = datasets.start({
				datasetId: a.datasetId,
				name: a.name,
				params,
				initialCash: a.initialCash,
				fees: { limitPpm: a.limitFeePpm, marketPpm: a.marketFeePpm },
				skipGaps: a.skipGaps,
				criteriaVersion: a.criteriaVersion ?? null,
			});
			if (!started.ok) return datasetFailure(started.error);
			const id = started.run.id;
			const deadline = Date.now() + backtestWaitMs;
			let run = datasets.run(id);
			while (run?.status === "running" && Date.now() < deadline) {
				await sleep(500);
				run = datasets.run(id);
			}
			return run
				? text(datasetRunView(run))
				: fail("まとめた実行が見つからない");
		},
	);

	server.registerTool(
		"get_dataset_run",
		{
			description:
				"データセットのまとめた実行1件の条件・合算した成績・相場データごとの成績。実行中なら進み具合",
			inputSchema: { id: z.number().int() },
			annotations: readOnly,
		},
		({ id }) => {
			const r = datasets.run(id);
			if (!r) return fail("まとめた実行が見つからない");
			return text({
				...datasetRunView(r),
				screenText: conditionSetScreenText(r.params).join("\n"),
				params: r.params,
			});
		},
	);

	server.registerTool(
		"list_trading_runs",
		{
			description:
				"ホームのタブ（運用）の一覧（作った順）。モード（paper=デモ・live=リアル）・稼働中か・運用する戦略・次の判定時刻・今日の確定損失と1日の損失上限。デモは口座（現金・保有・ロットごとの含み損益）・含み損益・口座のリセット以降の成績（通算損益・ガチホ・勝率など。画面と同じ5段階の評価付き）も返す。リアルは画面と同じく口座と成績を出さない。オンオフ・戦略の切替は画面から人が行う",
			annotations: readOnly,
		},
		() => {
			const price = market.latest().price;
			return text(
				trading.runs().map((r) => ({
					...tradingRunView(r),
					...(hidden(r) ? {} : paperView(r, price, trading.performance(r.id))),
				})),
			);
		},
	);

	server.registerTool(
		"get_strategy_watch",
		{
			description:
				"ホームの「次の動き」「戦略の見張り」。タブで運用する戦略を今の価格で試算した、買いとロットごとの条件の成立・今の値・発動価格（価格がいくらになれば成立するか）。actions は起きうる売買で、price が null なら今の価格のまま次の判定で起きる。nextMoves は画面の「次の動き」（次の判定で起きるものと、上側・下側それぞれ最も近い発動価格）。distancePercent は今の価格からの幅。注文はしない。リアルのタブは画面と同じく出さない",
			inputSchema: {
				runId: z.number().int().describe("タブ（list_trading_runs）"),
			},
			annotations: readOnly,
		},
		({ runId }) => {
			const run = trading.run(runId);
			if (!run) return fail("タブが見つからない");
			if (hidden(run)) return fail("リアルのタブは戦略の見張りを出さない");
			const w = trading.watch(runId)?.watch ?? null;
			return w
				? text(watchView(w))
				: fail("運用する戦略を選んでいないか、価格がまだ無い");
		},
	);

	server.registerTool(
		"list_trading_orders",
		{
			description:
				"タブ（運用）の注文・約定（新しい順）。発注の理由・約定・往復の損益（売りの pnl、手数料込み）・売りのロットの買値と利確/損切りの別（exitKind）・発注したときの市場評価（judgments）を含む。total と realizedPnl は件数で切らずに数えた件数と損益の合計。リアルのタブは画面と同じく出さない",
			inputSchema: {
				runId: z.number().int().describe("タブ（list_trading_runs）"),
				status: z
					.enum(["open", "filled", "canceled"])
					.optional()
					.describe("open=未約定・filled=約定・canceled=取消。省けばすべて"),
				side: z.enum(["buy", "sell"]).optional(),
				limit: z.number().int().min(1).max(500).default(100),
			},
			annotations: readOnly,
		},
		({ runId, status, side, limit }) => {
			const run = trading.run(runId);
			if (!run) return fail("タブが見つからない");
			if (hidden(run)) return fail("リアルのタブは注文・約定を出さない");
			const filter = { runId, status, side };
			const summary = trading.orderSummary(filter);
			return text({
				total: summary.count,
				realizedPnl: summary.realizedPnl,
				orders: trading.orders(filter, limit).map((o) => ({
					...tradingOrderView(o),
					judgments: judgmentsView(
						trading.order(runId, o.id)?.decision?.judgments,
					),
				})),
			});
		},
	);

	server.registerTool(
		"get_market_price",
		{
			description:
				"BTC/JPY の現在値（直近の約定の価格）・その時刻・24時間前の価格と変化率（%）、価格の収集の状態（止まっていれば理由と再接続の予定）。ホームのチャートの上端の値と同じ",
			annotations: readOnly,
		},
		() => {
			const m = market.latest();
			const c = m.collector;
			return text({
				price: m.price,
				priceTime: m.priceTime === null ? null : jst(m.priceTime),
				price24hAgo: m.price24hAgo,
				changePercent24h:
					m.price === null || m.price24hAgo === null || m.price24hAgo === 0
						? null
						: Math.round((m.price / m.price24hAgo - 1) * 10_000) / 100,
				collector: {
					state: c.state,
					error: c.error,
					stoppedSince: c.stoppedSince === null ? null : jst(c.stoppedSince),
					retryAt: c.retryAt === null ? null : jst(c.retryAt),
				},
			});
		},
	);

	server.registerTool(
		"get_price_bars",
		{
			description:
				"ホームのチャートの足（始値・高値・安値・終値・出来高）と、足ごとの市場評価（チャートの背景。採点の記録の前は null）。期間の中の新しいほうから limit 本を古い順で返す。volume は satoshi。最新の価格は get_market_price",
			inputSchema: {
				timeframe: z.enum(TIMEFRAMES as unknown as [Timeframe, ...Timeframe[]]),
				range: z
					.enum(["1d", "1w", "1m", "all"])
					.default("1w")
					.describe("1d=1日・1w=1週間・1m=30日・all=全期間"),
				limit: z.number().int().min(1).max(BARS_MAX).default(200),
			},
			annotations: readOnly,
		},
		({ timeframe, range, limit }) => {
			const r = market.bars(timeframe, range, 0);
			if (!r.ok) {
				return fail(
					`足が多すぎる（${r.count}本。上限 ${r.max}本）。期間を短くするか粗い粒度にする`,
				);
			}
			const bars = r.bars.slice(-limit);
			const first = bars[0];
			const last = bars.at(-1);
			if (!first || !last) return text({ total: 0, bars: [] });
			const step = TIMEFRAME_MS[timeframe];
			const series = judgments.series(first.time, last.time + step, step);
			const at = (j: Judge, time: number) => {
				const v = series.values[j][Math.floor((time - series.from) / step)];
				return v == null ? null : level(v);
			};
			return text({
				total: r.bars.length,
				firstScoredAt:
					series.firstScoredAt === null ? null : jst(series.firstScoredAt),
				bars: bars.map((b) => ({
					...b,
					time: jst(b.time),
					marketEvaluation: {
						sentiment: at("sentiment", b.time),
						risk: at("risk", b.time),
					},
				})),
			});
		},
	);

	server.registerTool(
		"get_scoring_setup",
		{
			description:
				"ニュースの AI 採点の仕組み: プロンプトの固定のひな形（{news} と {criteria} を差し込む）、採点の基準（編集できる部分）の全版と使用中の版、モデル、点数から市場評価を出す評価ルール（コード上の名前は aggregationRule）、採点の状態",
			annotations: readOnly,
		},
		() => {
			const c = scoring.criteria();
			const st = scoring.status();
			return text({
				template: c.template,
				criteria: c.versions.map((v) => ({
					version: v.version,
					active: v.version === c.activeVersion,
					note: v.note,
					createdAt: jst(v.createdAt),
					text: v.text,
				})),
				model: scoring.models(),
				aggregationRule: judgments.rule(),
				aggregationRuleNote:
					"判定は、採点済みのニュースの点数を重み付き平均にし、thresholds と比べて出す。重みは新しさの時刻（公開時刻と取得時刻の早いほう）に 1 で、ニュースの duration（AI が付けた影響の持続。short・medium・long）ごとの halfLifeHours で半分になり、半減期の 4 倍たったら 0。duration が none（相場に関係ない）のニュースは重み 0。重み 0 のニュースは平均に入れない。sentiment: plus2 以上=+2・plus1 以上=+1・minus2 未満=-2・minus1 未満=-1。risk: mild 以上=やや警戒・alert 以上=警戒・severe 以上=かなり警戒・crisis 以上=危機（mild 未満=平常）",
				status: {
					state: st.state,
					error: st.error,
					pending: st.pending,
				},
				rules:
					"運用の採点は1記事1回で、採点済みは基準や版を変えても採点し直さない。使用する版を切り替えると次に採点するニュースから使う。運用の判定では採点時刻より前には使わない。バックテストでは公開時刻に取得の間隔を足した時刻から使う。過去の記事を別の版で試すには rescore_news で採点し直し、run_backtest の criteriaVersion で版を指定する",
			});
		},
	);

	server.registerTool(
		"get_market_evaluation",
		{
			description:
				"市場評価（センチメント・リスク）と、その内訳（評価に使った記事を、記事の点数の段階ごとに数えた件数・平均点・重みの割合）。ニュース画面の「今の市場評価」と評価詳細のタブの「市場評価の内訳」と同じ。at で過去の時点を指定できる",
			inputSchema: { at: atSchema },
			annotations: readOnly,
		},
		(a) => {
			const t = atTime(a.at);
			if ("isError" in t) return t;
			const c = judgments.current(undefined, t.at);
			const result = <J extends Judge>(r: JudgeResult<J>) => ({
				...level(r.value),
				average: r.average,
				count: r.count,
			});
			return text({
				time: jst(c.time),
				firstScoredAt: c.firstScoredAt === null ? null : jst(c.firstScoredAt),
				results: {
					sentiment: result(c.results.sentiment),
					risk: result(c.results.risk),
				},
				breakdown: Object.fromEntries(
					JUDGES.map((j) => [
						j,
						c.breakdown[j].map((row) => ({
							...level(row.value),
							count: row.count,
							average: row.average,
							weightShare: ratio(row.share),
						})),
					]),
				),
				note: "breakdown は評価基準の上の段階から順。weightShare は重みの合計に占める割合（0〜1）。段階ごとの average × weightShare の和が全体の average になる",
			});
		},
	);

	server.registerTool(
		"preview_aggregation_rule",
		{
			description:
				"評価ルールの案での今の市場評価。保存しない（設定画面の評価ルールの「この設定での今の市場評価」と同じ。評価ルールの変更は画面で行う）",
			inputSchema: {
				rule: z
					.record(z.string(), z.unknown())
					.describe(
						"評価ルールの案。形は get_scoring_setup の aggregationRule",
					),
			},
			annotations: readOnly,
		},
		(a) => {
			const rule = parseAggregationRule(a.rule);
			if (!rule) return fail("評価ルールの形が違う");
			const errors = validateAggregationRule(rule);
			if (errors.length) return fail("評価ルールに入力の誤りがある", errors);
			const c = judgments.current(rule);
			return text({
				time: jst(c.time),
				results: Object.fromEntries(
					JUDGES.map((j) => {
						const r = c.results[j];
						return [
							j,
							{ ...level(r.value), average: r.average, count: r.count },
						];
					}),
				),
			});
		},
	);

	server.registerTool(
		"get_market_evaluation_analysis",
		{
			description:
				"市場評価の分析（ニュース画面の評価詳細のタブと同じ）。記事ごとの精度（運用の採点の点数の段階と、公開時刻から測る長さの後の値動きの段階のずれ。一致で 5、1段ずれるごとに 1 下げる）を観点ごとに集計する。byPrecision は精度ごと、byLevel は記事の段階ごと、byLevelAndMove は記事の段階×値動きの段階の件数。criteriaVersion（プロンプトの版）・appVersion（採点したアプリのバージョン）・model（採点したモデル）で絞れる。期間と測る長さ、値動きの段階の境目は設定画面の「精度」の値（settings）。at で過去の時点を指定できる",
			inputSchema: {
				at: atSchema,
				criteriaVersion: z
					.number()
					.int()
					.optional()
					.describe("この版のプロンプトで採点した記事だけ数える。省けばすべて"),
				appVersion: z
					.string()
					.optional()
					.describe(
						'このバージョンのアプリで採点した記事だけ数える。options.appVersions の version（ISO 8601）か、記録前の採点は "none"。省けばすべて',
					),
				model: z
					.string()
					.min(1)
					.optional()
					.describe(
						'このモデルで採点した記事だけ数える。options.models の model（OpenAI 互換は openai: の印付き）か、モデルの記録が無い採点は "none"。省けばすべて',
					),
			},
			annotations: readOnly,
		},
		(a) => {
			const t = atTime(a.at);
			if ("isError" in t) return t;
			let appBuiltAt: number | "none" | undefined;
			if (a.appVersion === "none") appBuiltAt = "none";
			else if (a.appVersion !== undefined) {
				const v = parseTime(a.appVersion);
				if (v === null)
					return fail(
						'appVersion は options.appVersions の version（ISO 8601）か "none"',
					);
				appBuiltAt = v;
			}
			const r = accuracy.accuracySummary(t.at, {
				criteriaVersion: a.criteriaVersion,
				appBuiltAt,
				model: a.model,
			});
			const s = accuracy.accuracySettings();
			return text({
				time: jst(r.time),
				settings: {
					horizon: r.horizon,
					periodDays: r.periodDays,
					sentimentBandsPct: s.sentimentBands[r.horizon],
					riskBandsPct: s.riskBands[r.horizon],
				},
				filter: {
					criteriaVersion: r.filter.criteriaVersion,
					appVersion:
						typeof r.filter.appBuiltAt === "number"
							? jst(r.filter.appBuiltAt)
							: r.filter.appBuiltAt,
					model: r.filter.model,
				},
				options: {
					criteriaVersions: r.options.criteriaVersions.map((o) => ({
						...o,
						active: o.version === r.options.activeCriteriaVersion,
					})),
					appVersions: r.options.appBuiltAts.map((o) => ({
						version: o.builtAt === null ? "none" : jst(o.builtAt),
						count: o.count,
					})),
					models: r.options.models.map((o) => ({
						model: o.model ?? "none",
						count: o.count,
						active: o.model === r.options.activeModel,
					})),
				},
				results: {
					sentiment: analysisView("sentiment", r.results.sentiment),
					risk: analysisView("risk", r.results.risk),
				},
				note: "数えるのは公開時刻が time から periodDays 日（null はすべて）遡った時刻より後で time 以前の記事（filter で版・モデルを絞ったときはそれで採点したものだけ。採点し直して置き換えた記事は置き換えた後の版・モデル）。options は期間内で数える記事がある版・モデルと、絞る前の件数。モデルごとに採点した時期が違うので、モデルの違いと時期（相場・記事）の違いは分けられない。測定中・値動き不明・持続なし・採点済みでない記事は数えない。記事の段階は今の評価基準で点数から出す。センチメントは値動きの5段階（大きく下落〜大きく上昇）と、リスクは値動きの大きさの5段階（静か〜大荒れ）と、平常＝静か・…・危機＝大荒れ として比べる。sentimentBandsPct は small 未満が横ばい・large 以上が大きく動いた、riskBandsPct はそれぞれの段階の始まり（上下とも同じ幅の騰落率 %）",
			});
		},
	);

	server.registerTool(
		"list_news_scores",
		{
			description:
				"ニュースと AI の採点（点数・持続・理由・基準の版・モデル）、市場評価での重み、記事ごとの精度。ニュース画面の一覧と同じ条件で絞れる。weight は市場評価の時点（to が今より前ならその時刻、それ以外は今）での重み（0〜1）。precision は get_market_evaluation_analysis と同じ精度で、measuring は測る長さがまだたっていない、unknown は価格が無い、null は持続なし・採点済みでない記事。rescore は画面から頼んだ運用の採点の置き換え（採点し直し）で終わっていないもの。status は running: 採点し直し中 / waiting: 順番待ち（ahead は先に採点し直す件数。採点し直し中の1件とバックテスト用の分を含む。新着の採点が先） / retry: 失敗して nextAttemptAt に再試行 / failed: 失敗して止まっている",
			inputSchema: {
				from: z
					.string()
					.optional()
					.describe(
						"公開時刻の始まり。ISO 8601（タイムゾーン付き）か YYYY-MM-DD（JST）",
					),
				to: z
					.string()
					.optional()
					.describe("公開時刻の終わり（含まない）。書き方は from と同じ"),
				q: z
					.string()
					.max(200)
					.default("")
					.describe(
						"空白で区切った語をすべて含むもの（見出し・概要・採点の理由のどれかに。英字の大小は区別しない）",
					),
				impacts: z
					.array(z.enum(NEWS_IMPACTS))
					.default([])
					.describe(
						"影響の大きさ（今の評価基準で測る）。どれかに当てはまる採点済みのもの。bull: 強気材料（やや強気以上） / bear: 弱気材料（やや弱気以下） / risk: リスク高（警戒以上）",
					),
				durations: z
					.array(z.enum(DURATIONS))
					.default([])
					.describe("持続。どれかに当てはまる採点済みのもの"),
				active: z
					.boolean()
					.default(false)
					.describe(
						"市場評価の時点で評価に使っている（重みが 0 より大きい）ものだけ",
					),
				sort: z
					.enum(NEWS_SORTS)
					.default("new")
					.describe(
						"new: 新しい順 / impact: 影響の大きい順（センチメントの点数の絶対値とリスクの点数の大きい方。採点済みでないものは最後）",
					),
				offset: z.number().int().min(0).default(0),
				limit: z.number().int().min(1).max(200).default(50),
			},
			annotations: readOnly,
		},
		(a) => {
			const from = a.from === undefined ? null : parseTime(a.from);
			const to = a.to === undefined ? null : parseTime(a.to);
			if (
				(a.from !== undefined && from === null) ||
				(a.to !== undefined && to === null)
			) {
				return fail(
					"from・to はタイムゾーン付きの ISO 8601 か YYYY-MM-DD で書く",
				);
			}
			// 画面の一覧が読めるのは 1000 件まで
			if (a.offset + a.limit > NEWS_LIST_MAX) {
				return fail(`offset + limit は ${NEWS_LIST_MAX} 以下にする`);
			}
			// 画面と同じく、市場評価の時点は to が今より前ならその時刻（先の時刻は今になる）
			const c = judgments.current(undefined, to ?? undefined);
			const r = news.searchNews({
				from,
				to,
				q: a.q.trim(),
				impacts: a.impacts,
				durations: a.durations,
				activeAt: a.active ? c.time : null,
				sort: a.sort,
				limit: a.offset + a.limit,
			});
			const items = r.news.slice(a.offset);
			const acc = accuracy.articleAccuracy(items.map((n) => n.id));
			const byId = new Map(acc.items.map((x) => [x.id, x]));
			return text({
				total: r.total,
				evaluationTime: jst(c.time),
				precisionHorizon: acc.horizon,
				items: items.map((n) =>
					newsView(n, c.weights[String(n.id)], byId.get(n.id)),
				),
			});
		},
	);

	server.registerTool(
		"trial_scoring",
		{
			description: `採点の基準の案で、指定した過去のニュース（${TRIAL_MAX_NEWS} 件まで。省けば最新の1件）を採点し直す。保存も集計への反映もしない。保存済みの採点と並べて返す（設定画面のプロンプトの試し採点と同じ）。AI の回数制限のため1件につき5秒ほどかかる`,
			inputSchema: {
				criteria: z.string().describe("採点の基準の案（ひな形の {criteria}）"),
				newsIds: z.array(z.number().int()).max(TRIAL_MAX_NEWS).optional(),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ criteria, newsIds }) => {
			const r = await scoring.trial(criteria, newsIds);
			if (!r.ok) return fail(r.message);
			return text(
				r.items.map((x) => ({
					news: { ...x.news, publishedAt: jst(x.news.publishedAt) },
					result: x.result,
				})),
			);
		},
	);

	server.registerTool(
		"rescore_news",
		{
			description:
				"バックテストの期間の市場評価に使うニュースを、保存済みの基準の版で採点し直して保存する（運用の採点は変えない）。run_backtest で criteriaVersion を指定するのに使う。採点は裏で1件5秒ほどかけて進むので、同じ引数で呼び直して進み具合（coverage）を見る。失敗したものは呼び直すと再び採点する",
			inputSchema: {
				version: z.number().int(),
				from: z
					.string()
					.describe(
						"バックテストの開始。ISO 8601（タイムゾーン付き）か YYYY-MM-DD（JST）",
					),
				to: z
					.string()
					.describe("バックテストの終了（含まない）。書き方は from と同じ"),
			},
			annotations: { destructiveHint: false, openWorldHint: true },
		},
		(a) => {
			const from = parseTime(a.from);
			const to = parseTime(a.to);
			if (from === null || to === null) {
				return fail(
					"from・to はタイムゾーン付きの ISO 8601 か YYYY-MM-DD で書く",
				);
			}
			const r = scoring.requestRescore(from, to, a.version);
			if (!r.ok) return fail(r.message);
			return text({
				coverage: r.coverage,
				note: "done + failed = total になれば run_backtest で criteriaVersion を指定できる。failed の記事は除いて実行する",
			});
		},
	);

	server.registerTool(
		"add_scoring_criteria",
		{
			description:
				"採点の基準を新しい版として保存する。使用する版は切り替えない（set_active_scoring_criteria で切り替える）",
			inputSchema: {
				text: z.string().describe("採点の基準（4000 文字以内）"),
				note: z.string().describe("版の説明（100 文字以内）。何を変えたか"),
			},
			annotations: { destructiveHint: false, openWorldHint: false },
		},
		(a) => {
			const r = scoring.addCriteria(
				a.text,
				a.note.trim() || "Claude Code から",
			);
			if (!r.ok) return fail(r.message);
			return text({
				version: r.version.version,
				note: r.version.note,
				createdAt: jst(r.version.createdAt),
			});
		},
	);

	server.registerTool(
		"set_active_scoring_criteria",
		{
			description:
				"採点に使う基準の版を切り替える。次に採点するニュースから使い、自動取引の判定にも効く。採点済みのニュースは採点し直さない。切り替える前に利用者に確認を取る",
			inputSchema: { version: z.number().int() },
			annotations: {
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		({ version }) => {
			if (!scoring.setActiveCriteria(version)) return fail("版が見つからない");
			return text({ activeVersion: scoring.criteria().activeVersion });
		},
	);

	return server;
}

function strategyFailure(
	e: Extract<ReturnType<StrategyService["create"]>, { ok: false }>["error"],
) {
	switch (e.kind) {
		case "not_found":
			return fail("戦略が見つからない");
		case "invalid_name":
		case "duplicate_name":
			return fail(e.message);
		case "invalid_params":
			return fail("条件に入力の誤りがある", e.errors);
	}
}

/** /mcp に置く。セッションを持たず、要求ごとにサーバーを作る */
export function mcpRoutes(deps: McpDeps) {
	return new Hono().all("/", async (c) => {
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		const server = createServer(deps);
		await server.connect(transport);
		return transport.handleRequest(c.req.raw);
	});
}
