// MCP の道具のうち、market-data の機能のもの

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import type { ToolDeps } from "../mcp/tool-app";
import { readOnly, text } from "../mcp/tool-app";
import { jst } from "../mcp/views-domain";

export function registerMarketDataTools(
	server: McpServer,
	{ marketData, marketDataByInstrument }: ToolDeps,
) {
	const ids = marketDataByInstrument.map((s) => s.instrument.id);
	server.registerTool(
		"get_data_coverage",
		{
			description: "バックテストに使える価格データの粒度ごとの範囲と欠損の数",
			inputSchema: {
				instrument: z
					.enum(ids as [string, ...string[]])
					.optional()
					.describe(`銘柄。省くと ${marketData.instrument.id}`),
			},
			annotations: readOnly,
		},
		({ instrument }) =>
			text(
				(
					marketDataByInstrument.find((s) => s.instrument.id === instrument) ??
					marketData
				)
					.coverage()
					.map((c) => ({
						timeframe: c.timeframe,
						count: c.count,
						first: c.firstTime === null ? null : jst(c.firstTime),
						last: c.lastTime === null ? null : jst(c.lastTime),
						gapCount: c.gaps.length,
					})),
			),
	);
}
