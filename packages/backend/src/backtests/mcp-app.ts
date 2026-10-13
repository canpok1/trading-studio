// MCP の道具のうち、backtests の機能のもの。サーバーへの登録は mcp/mcp-app.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConditionSet } from "@trading-studio/core";
import * as z from "zod";
import { feeSchema } from "../mcp/schemas-domain";
import type { McpDeps } from "../mcp/tool-app";
import {
	BACKTEST_WAIT_MS,
	fail,
	paramsSchema,
	readOnly,
	text,
} from "../mcp/tool-app";
import {
	datasetRunView,
	jst,
	parseTime,
	runDetailView,
	runView,
} from "../mcp/views-domain";
import { parseParamsInput } from "../strategies/strategies-domain";
import type { StartBacktestFailure } from "./types-domain";

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

export function registerBacktestTools(
	server: McpServer,
	{
		strategies,
		backtests,
		datasets,
		backtestWaitMs = BACKTEST_WAIT_MS,
		sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
	}: McpDeps,
) {
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
			return text(runDetailView(r));
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
				...feeSchema,
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
				params = parseParamsInput({ params: a.params });
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
}
