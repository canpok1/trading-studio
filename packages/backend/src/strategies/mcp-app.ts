// MCP の道具のうち、strategies の機能のもの。サーバーへの登録は mcp/mcp-app.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import type { McpDeps } from "../mcp/tool-app";
import { fail, paramsSchema, readOnly, text } from "../mcp/tool-app";
import { strategyView } from "../mcp/views-domain";
import { conditionSetGuide } from "./guide-domain";
import { parseParamsInput } from "./strategies-domain";
import type { StrategyService } from "./types-domain";

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

export function registerStrategyTools(
	server: McpServer,
	{ strategies, inUse }: McpDeps,
) {
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
			const p = parseParamsInput({ params });
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
			const p = parseParamsInput({ params });
			if (!p) return fail("条件セットの形が違う。get_guide を参照");
			const r = strategies.updateParams(id, p);
			if (!r.ok) return strategyFailure(r.error);
			return text(strategyView(r.strategy, inUse));
		},
	);
}
