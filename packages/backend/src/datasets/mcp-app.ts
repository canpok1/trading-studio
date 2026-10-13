// MCP の道具のうち、datasets の機能のもの。サーバーへの登録は mcp/mcp-app.ts

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
	datasetRunDetailView,
	datasetRunView,
	datasetView,
	segmentRef,
} from "../mcp/views-domain";
import { parseParamsInput } from "../strategies/strategies-domain";
import type { StartDatasetFailure } from "./types-domain";

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
					segment: segmentRef(b.segment),
					kind: b.error.kind,
					message:
						"message" in b.error
							? b.error.message
							: "期間内にデータの欠損がある",
				})),
			);
	}
}

export function registerDatasetTools(
	server: McpServer,
	{
		strategies,
		datasets,
		backtestWaitMs = BACKTEST_WAIT_MS,
		sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
	}: McpDeps,
) {
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
				...feeSchema,
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
				params = parseParamsInput({ params: a.params });
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
			return text(datasetRunDetailView(r));
		},
	);
}
