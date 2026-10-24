// MCP の道具のうち、strategies の機能のもの

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { COLLECTED_IDS } from "../market-data/instrument-domain";
import type { ToolDeps } from "../mcp/tool-app";
import { fail, paramsSchema, readOnly, text } from "../mcp/tool-app";
import { strategyView } from "../mcp/views-domain";
import { conditionSetGuide } from "./guide-domain";
import { parseParamsInput } from "./strategies-domain";
import type { StrategyService } from "./types-domain";

const instrumentsSchema = z.array(z.enum(COLLECTED_IDS)).optional();

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
	{ strategies, trading }: ToolDeps,
) {
	const lock = (id: number) => trading.strategyLock(id);
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
				"保存済みの戦略の一覧（作った順）。lock は条件を変えられない理由（running=自動取引がオン、holding=保有か未約定の注文がある）で、変えられれば null。自動取引の状態は list_auto_trading",
			annotations: readOnly,
		},
		() => {
			return text(
				strategies.list().map((s) => {
					const { params: _, ...rest } = strategyView(s, lock);
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
			return s ? text(strategyView(s, lock)) : fail("戦略が見つからない");
		},
	);

	server.registerTool(
		"create_strategy",
		{
			description:
				"条件セットから新しい戦略を保存する。名前は 1〜40 文字で既存と重複できない",
			inputSchema: {
				name: z.string(),
				params: paramsSchema,
				instruments: instrumentsSchema.describe(
					"候補の銘柄の id。省くと BTC/JPY だけ。2つ以上なら maxHoldings と ranking が効き、注文量は orderAmount（金額）で入れる。DVOL の条件があれば BTC/JPY だけ",
				),
			},
			annotations: { destructiveHint: false, openWorldHint: false },
		},
		({ name, params, instruments }) => {
			const p = parseParamsInput({ params });
			if (!p) return fail("条件セットの形が違う。get_guide を参照");
			const r = trading.createStrategy({
				name,
				from: instruments ? { params: p, instruments } : { params: p },
			});
			if (!r.ok) return strategyFailure(r.error);
			return text(strategyView(r.strategy, lock));
		},
	);

	server.registerTool(
		"update_strategy",
		{
			description:
				"戦略の条件を置き換える。lock がある戦略（自動取引がオンか、保有か未約定の注文がある）は変えられない。残したい元の条件があるなら create_strategy で別に作る",
			inputSchema: {
				id: z.number().int(),
				params: paramsSchema,
				instruments: instrumentsSchema.describe(
					"候補の銘柄の id。省くと今の候補のまま。2つ以上なら maxHoldings と ranking が効き、注文量は orderAmount（金額）で入れる。DVOL の条件があれば BTC/JPY だけ",
				),
			},
			annotations: {
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		({ id, params, instruments }) => {
			if (trading.strategyLock(id)) {
				return fail(
					"自動取引がオンか、保有か未約定の注文がある戦略は変えられない。create_strategy で新しい戦略として作る",
				);
			}
			const p = parseParamsInput({ params });
			if (!p) return fail("条件セットの形が違う。get_guide を参照");
			const r = strategies.updateParams(id, p, instruments);
			if (!r.ok) return strategyFailure(r.error);
			return text(strategyView(r.strategy, lock));
		},
	);
}
