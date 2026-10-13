// MCP の道具のうち、advice の機能のもの。サーバーへの登録は mcp/mcp-app.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import type { McpDeps } from "../mcp/tool-app";
import { readOnly, text } from "../mcp/tool-app";
import { jst } from "../mcp/views-domain";

export function registerAdviceTools(server: McpServer, { advice }: McpDeps) {
	server.registerTool(
		"get_backtest_advice",
		{
			description:
				"バックテストの結果画面の AI アドバイス（結果の分析・うまくいった点・悪かった点・改善案・改善案を反映した条件セット）と、作った時刻・モデル・指示の版。作るのは画面から（API の料金がかかるため道具にしない）。まだ無ければ null",
			inputSchema: { id: z.number().int().describe("バックテストの id") },
			annotations: readOnly,
		},
		({ id }) => {
			const a = advice.get(id);
			if (!a) return text(null);
			return text({
				status: a.status,
				content: a.content,
				model: a.model,
				instructionsVersion: a.instructionsVersion,
				appVersion: a.appBuiltAt === null ? null : jst(a.appBuiltAt),
				startedAt: jst(a.startedAt),
				finishedAt: a.finishedAt === null ? null : jst(a.finishedAt),
				error: a.error,
			});
		},
	);
}
