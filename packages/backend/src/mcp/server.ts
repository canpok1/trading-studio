// ローカルの Claude Code から戦略の相談をするための MCP（Streamable HTTP）。docs/mcp.md
// 自動取引のオンオフ・運用する戦略の切替と変更・削除・設定は道具にしない（画面から人が行う）

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ConditionSet } from "@trading-studio/core";
import { DEFAULT_FEE_RATES, parseConditionSet } from "@trading-studio/core";
import { Hono } from "hono";
import * as z from "zod";
import { conditionSetScreenText } from "../advice/screen-text";
import type {
	BacktestRun,
	BacktestService,
	StartBacktestFailure,
} from "../backtests/types";
import type { MarketDataService } from "../market-data/types";
import type { StoredStrategy, StrategyService } from "../strategies/types";
import { conditionSetGuide } from "./guide";

export type McpDeps = {
	strategies: StrategyService;
	backtests: BacktestService;
	marketData: MarketDataService;
	/** run_backtest が終わりを待つ時間。過ぎたら実行中のまま返し、get_backtest で続きを見てもらう */
	backtestWaitMs?: number;
	sleep?: (ms: number) => Promise<void>;
};

const JST_OFFSET_MS = 9 * 3_600_000;

/** エポックミリ秒を JST の ISO 8601 にする */
export const jst = (ms: number) =>
	new Date(ms + JST_OFFSET_MS).toISOString().replace(".000Z", "+09:00");

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

function strategyView(s: StoredStrategy, activeId: number | null) {
	return {
		id: s.id,
		name: s.name,
		active: s.id === activeId,
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
		timeframe: r.timeframe,
		stepTimeframe: r.stepTimeframe,
		stepLimited: r.stepLimited,
		initialCash: r.initialCash,
		fees: r.fees,
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

function createServer({
	strategies,
	backtests,
	marketData,
	backtestWaitMs = 120_000,
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}: McpDeps) {
	const server = new McpServer(
		{ name: "trading-studio", version: "1.0.0" },
		{
			instructions:
				"BTC/JPY の自動売買アプリ trading-studio。戦略の条件を相談して改良するための道具。まず get_guide で条件セットの書き方を読む。戦略の新規作成・運用中でない戦略の条件変更・バックテストの実行ができる。自動取引のオンオフや運用する戦略の切替・変更はできない（画面で人が行う）。",
		},
	);
	const activeId = () => strategies.active()?.id ?? null;
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
				"保存済みの戦略の一覧。active は運用する戦略（自動取引で使う）で、条件を変えられない",
			annotations: readOnly,
		},
		() => {
			const a = activeId();
			return text(
				strategies.list().map((s) => {
					const { params: _, ...rest } = strategyView(s, a);
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
			return s ? text(strategyView(s, activeId())) : fail("戦略が見つからない");
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
			return text(strategyView(r.strategy, activeId()));
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
			if (id === activeId()) {
				return fail(
					"運用する戦略は変えられない。create_strategy で新しい戦略として作る",
				);
			}
			const p = parseConditionSet(params);
			if (!p) return fail("条件セットの形が違う。get_guide を参照");
			const r = strategies.updateParams(id, p);
			if (!r.ok) return strategyFailure(r.error);
			return text(strategyView(r.strategy, activeId()));
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
		({ limit }) =>
			text(
				backtests
					.list()
					.slice(0, limit)
					.map((r) => runView(r)),
			),
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
