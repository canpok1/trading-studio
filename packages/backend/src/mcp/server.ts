// ローカルの Claude Code から戦略とニュースの採点を相談するための MCP（Streamable HTTP）。docs/mcp.md
// 自動取引のオンオフ・運用する戦略の切替と変更・削除・設定は道具にしない（画面から人が行う）。
// 例外は採点の基準の版の保存と切替（docs/adr/0013）

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AggregationRule, ConditionSet } from "@trading-studio/core";
import {
	conditionSetScreenText,
	DEFAULT_FEE_RATES,
	parseAggregationRule,
	parseConditionSet,
	validateAggregationRule,
} from "@trading-studio/core";
import { Hono } from "hono";
import * as z from "zod";
import type {
	BacktestRun,
	BacktestService,
	StartBacktestFailure,
} from "../backtests/types";
import type { JudgmentService } from "../judgments/types";
import type { MarketDataService } from "../market-data/types";
import type { ScoringService } from "../news/types";
import type { AnalysisNewsRow } from "../scoring-analysis/repository";
import type {
	ScoredNewsView,
	ScoringAnalysisService,
} from "../scoring-analysis/service";
import { MAX_ANALYSIS_DAYS } from "../scoring-analysis/service";
import type { StoredStrategy, StrategyService } from "../strategies/types";
import { conditionSetGuide } from "./guide";

export type McpDeps = {
	strategies: StrategyService;
	backtests: BacktestService;
	marketData: MarketDataService;
	scoring: ScoringService;
	judgments: Pick<JudgmentService, "rule">;
	scoringAnalysis: ScoringAnalysisService;
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

function newsView(r: AnalysisNewsRow | ScoredNewsView) {
	return {
		id: r.id,
		source: r.sourceName,
		language: r.language,
		title: r.title,
		summary: r.summary,
		url: r.url,
		publishedAt: jst(r.publishedAt),
		fetchedAt: jst(r.fetchedAt),
		status: r.status ?? "unscored",
		scores:
			r.status === "done" ? { sentiment: r.sentiment, risk: r.risk } : null,
		duration: r.status === "done" ? r.duration : null,
		comment: r.comment,
		scoredAt: r.scoredAt === null ? null : jst(r.scoredAt),
		criteriaVersion: r.criteriaVersion,
		model: r.model,
		appVersion: r.appBuiltAt === null ? null : jst(r.appBuiltAt),
		error: r.error,
		...("returns" in r ? { returnsAfterScoredPct: r.returns } : {}),
	};
}

/** 分析の期間。読めないか長すぎればエラーの応答 */
function period(a: { from: string; to: string }) {
	const from = parseTime(a.from);
	const to = parseTime(a.to);
	if (from === null || to === null) {
		return fail("from・to はタイムゾーン付きの ISO 8601 か YYYY-MM-DD で書く");
	}
	if (to <= from) return fail("to は from より後にする");
	if (to - from > MAX_ANALYSIS_DAYS * 86_400_000) {
		return fail(`期間は ${MAX_ANALYSIS_DAYS} 日以内にする`);
	}
	return { from, to };
}

const periodSchema = {
	from: z
		.string()
		.describe("開始。ISO 8601（タイムゾーン付き）か YYYY-MM-DD（JST）"),
	to: z.string().describe("終了（含まない）。書き方は from と同じ"),
};

const RETURNS_NOTE =
	"騰落率は % で、1h・4h・24h 後の終値と比べる（価格の足が無ければ null）";

function createServer({
	strategies,
	backtests,
	marketData,
	scoring,
	judgments,
	scoringAnalysis,
	inUse,
	backtestWaitMs = BACKTEST_WAIT_MS,
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}: McpDeps) {
	const server = new McpServer(
		{ name: "trading-studio", version: "1.0.0" },
		{
			instructions:
				"BTC/JPY の自動売買アプリ trading-studio。戦略の条件と、ニュースの AI 採点の基準を相談して改良するための道具。戦略: まず get_guide で条件セットの書き方を読む。戦略の新規作成・運用中でない戦略の条件変更・バックテストの実行ができる。自動取引のオンオフや運用する戦略の切替・変更はできない（画面で人が行う）。採点: get_scoring_setup で仕組みと今の基準を読み、list_news_scores・evaluate_news_scores・evaluate_judgments で採点と判定がその後の値動きと合っていたかを調べ、trial_scoring で基準の案を過去のニュースに試し、add_scoring_criteria で版として保存し、rescore_news と run_backtest の criteriaVersion でその版の成績を確かめ、set_active_scoring_criteria で使い始める。切り替えると次に採点するニュースから効き、自動取引の判定にも効くので、切り替える前に利用者に確認を取る。",
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
		"list_backtests",
		{
			description: "バックテストの実行の一覧（新しい順）と成績",
			inputSchema: {
				limit: z.number().int().min(1).max(100).default(20),
			},
			annotations: readOnly,
		},
		({ limit }) => text(backtests.list({ limit }).runs.map((r) => runView(r))),
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
				"バックテストを実行し、終わるまで待って成績を返す。strategyId か params のどちらかで条件を渡す。同時に実行できるのは1つ。待ちきれなければ実行中のまま返すので get_backtest で見る",
			inputSchema: {
				name: z.string().describe("バックテスト名（1〜40 文字）"),
				strategyId: z.number().int().optional(),
				params: paramsSchema.optional(),
				from: z
					.string()
					.describe("開始。ISO 8601（タイムゾーン付き）か YYYY-MM-DD（JST）"),
				to: z.string().describe("終了（含まない）。書き方は from と同じ"),
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
			const from = parseTime(a.from);
			const to = parseTime(a.to);
			if (from === null || to === null) {
				return fail(
					"from・to はタイムゾーン付きの ISO 8601 か YYYY-MM-DD で書く",
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
					"判定は、採点済みのニュースの点数を重み付き平均にし、thresholds と比べて出す。重みは新しさの時刻（公開時刻と取得時刻の早いほう）に 1 で、ニュースの duration（AI が付けた影響の持続。short・medium・long）ごとの halfLifeHours で半分になり、半減期の 4 倍たったら 0。duration が none（相場に関係ない）のニュースは重み 0。重み 0 のニュースは平均に入れない。sentiment: plus2 以上=+2・plus1 以上=+1・minus2 未満=-2・minus1 未満=-1。risk: caution 以上=警戒・crisis 以上=危機",
				status: {
					state: st.state,
					error: st.error,
					pending: st.pending,
				},
				rules:
					"運用の採点は1記事1回で、採点済みは基準や版を変えても採点し直さない。使用する版を切り替えると次に採点するニュースから使う。採点時刻より前の判定には使わない。過去の記事を別の版で試すには rescore_news で採点し直し、run_backtest の criteriaVersion で版を指定する（採点し直した記事も、判定に使い始める時刻は運用の採点時刻のまま）",
			});
		},
	);

	server.registerTool(
		"list_news_scores",
		{
			description: `ニュースと AI の採点（点数・理由・基準の版・モデル）を新しい順に返す。採点済みのものには採点時刻からの値動きを付ける。${RETURNS_NOTE}`,
			inputSchema: {
				...periodSchema,
				criteriaVersion: z.number().int().optional(),
				status: z
					.enum(["all", "done", "retry", "failed", "skipped", "unscored"])
					.default("all")
					.describe(
						"done: 採点済み / retry: 再試行待ち / failed: 採点に失敗 / skipped: 古いので採点しない / unscored: 未採点",
					),
				offset: z.number().int().min(0).default(0),
				limit: z.number().int().min(1).max(200).default(50),
			},
			annotations: readOnly,
		},
		(a) => {
			const p = period(a);
			if ("isError" in p) return p;
			const r = scoringAnalysis.listNews(
				{
					...p,
					criteriaVersion: a.criteriaVersion,
					status: a.status === "all" ? undefined : a.status,
				},
				a.offset,
				a.limit,
			);
			return text({
				total: r.total,
				priceTimeframe: r.priceTimeframe,
				items: r.items.map(newsView),
			});
		},
	);

	server.registerTool(
		"evaluate_news_scores",
		{
			description: `期間内の採点済みニュースの点数と、採点時刻からの値動きの関係を、基準の版ごと・観点ごとに集計する。correlation は点数と騰落率の相関係数（risk は騰落率の絶対値と）。directionHit は |点数| が 20 以上のものの向きの当たり率。bands は点数の帯ごとの騰落率。baseline は全ニュースの騰落率。${RETURNS_NOTE}`,
			inputSchema: {
				...periodSchema,
				criteriaVersion: z.number().int().optional(),
			},
			annotations: readOnly,
		},
		(a) => {
			const p = period(a);
			if ("isError" in p) return p;
			return text(
				scoringAnalysis.evaluateScores({
					...p,
					criteriaVersion: a.criteriaVersion,
				}),
			);
		},
	);

	server.registerTool(
		"evaluate_judgments",
		{
			description: `期間内の1時間ごとの判定（センチメント・リスク）と、その時刻からの値動きを、判定の値ごとに集計する。rule を渡すとその評価ルールで計算し直す（保存しない。評価ルールの変更は画面で行う）。baseline は全時間の騰落率。${RETURNS_NOTE}`,
			inputSchema: {
				...periodSchema,
				rule: z
					.record(z.string(), z.unknown())
					.optional()
					.describe(
						"評価ルールの案。形は get_scoring_setup の aggregationRule",
					),
			},
			annotations: readOnly,
		},
		(a) => {
			const p = period(a);
			if ("isError" in p) return p;
			let rule: AggregationRule | undefined;
			if (a.rule !== undefined) {
				const r = parseAggregationRule(a.rule);
				if (!r) return fail("評価ルールの形が違う");
				const errors = validateAggregationRule(r);
				if (errors.length) return fail("評価ルールに入力の誤りがある", errors);
				rule = r;
			}
			const r = scoringAnalysis.evaluateJudgments(p.from, p.to, rule);
			return text({
				...r,
				firstScoredAt: r.firstScoredAt === null ? null : jst(r.firstScoredAt),
				rule: rule ?? judgments.rule(),
			});
		},
	);

	server.registerTool(
		"trial_scoring",
		{
			description:
				"採点の基準の案で、指定した過去のニュースを採点し直す。保存も集計への反映もしない。保存済みの採点と値動きと並べて返す。AI の回数制限のため1件につき5秒ほどかかる",
			inputSchema: {
				criteria: z.string().describe("採点の基準の案（ひな形の {criteria}）"),
				newsIds: z.array(z.number().int()).min(1).max(10),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ criteria, newsIds }) => {
			const r = await scoringAnalysis.trial(criteria, newsIds);
			if (!r.ok) return fail(r.message);
			return text(
				r.items.map((x) => ({
					news: newsView(x.news),
					trial: x.trial,
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
