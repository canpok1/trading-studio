// MCP の道具のうち、market-data の機能のもの。サーバーへの登録は mcp/mcp-app.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpDeps } from "../mcp/tool-app";
import { readOnly, text } from "../mcp/tool-app";
import { jst } from "../mcp/views-domain";

export function registerMarketDataTools(
	server: McpServer,
	{ marketData }: McpDeps,
) {
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
}
