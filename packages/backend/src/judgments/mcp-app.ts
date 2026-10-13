// MCP の道具のうち、judgments の機能のもの。サーバーへの登録は mcp/mcp-app.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import type { McpDeps } from "../mcp/tool-app";
import { atSchema, atTime, fail, readOnly, text } from "../mcp/tool-app";
import { evaluationView, jst, resultsView } from "../mcp/views-domain";
import { parseRuleInput } from "./judgments-domain";

export function registerJudgmentTools(
	server: McpServer,
	{ judgments }: McpDeps,
) {
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
			return text(evaluationView(judgments.current(undefined, t.at)));
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
			const rule = parseRuleInput({ rule: a.rule });
			if (!rule) return fail("評価ルールの形が違う");
			const r = judgments.preview(rule);
			if (!r.ok) return fail("評価ルールに入力の誤りがある", r.errors);
			return text({
				time: jst(r.judgment.time),
				results: resultsView(r.judgment),
			});
		},
	);
}
