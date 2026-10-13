// MCP の道具のうち、segments の機能のもの

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { regimeSchema } from "../mcp/schemas-domain";
import type { ToolDeps } from "../mcp/tool-app";
import { readOnly, text } from "../mcp/tool-app";
import { segmentView } from "../mcp/views-domain";

export function registerSegmentTools(
	server: McpServer,
	{ segments }: ToolDeps,
) {
	server.registerTool(
		"list_segments",
		{
			description:
				"相場データ（画面の呼び名。コード上の名前は segment）の一覧（新しい順）。毎月、直近2か月の期間に相場のラベル（上昇・下落・レンジ・乱高下）を1つ付けて作る。run_backtest の segmentId に渡すとその期間で実行する。returnPercent は期間の騰落率、volatilityPercent は日ごとの騰落率の標準偏差",
			inputSchema: {
				regime: regimeSchema
					.optional()
					.describe(
						"相場で絞る。up=上昇・down=下落・range=レンジ・volatile=乱高下",
					),
			},
			annotations: readOnly,
		},
		({ regime }) => text(segments.list(regime ?? null).map(segmentView)),
	);
}
