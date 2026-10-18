// MCP の道具のうち、dvol の機能のもの

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { dvolAverageDaysSchema } from "../mcp/schemas-domain";
import type { ToolDeps } from "../mcp/tool-app";
import { readOnly, text } from "../mcp/tool-app";
import { jst } from "../mcp/views-domain";

/** get_dvol_bars で一度に返す足の上限 */
const BARS_MAX = 2_000;

export function registerDvolTools(server: McpServer, { dvol }: ToolDeps) {
	server.registerTool(
		"get_dvol_bars",
		{
			description:
				"Deribit の DVOL（BTC オプションから計算した30日の予想ボラ、年率 %）の1時間足（始値・高値・安値・終値）。チャートの DVOL の小窓と同じ。期間の中の新しいほうから limit 本を古い順で返す。最後の足は確定前のことがある。averageDays を指定すると、各足が終わった時点の直近 N 日の終値の平均（戦略の条件「DVOL（平均との比）」と同じ計算、足りなければ null）を average に付ける",
			inputSchema: {
				range: z
					.enum(["1d", "1w", "1m", "all"])
					.default("1w")
					.describe("1d=1日・1w=1週間・1m=30日・all=全期間"),
				limit: z.number().int().min(1).max(BARS_MAX).default(200),
				averageDays: dvolAverageDaysSchema
					.optional()
					.describe("平均の日数（1〜30）。チャートの DVOL の平均の線と同じ"),
			},
			annotations: readOnly,
		},
		({ range, limit, averageDays }) => {
			const bars = dvol.recent(range, limit, averageDays);
			const pct = (v: number) => v / 100;
			return text({
				bars: bars.map((b) => ({
					time: jst(b.time),
					open: pct(b.open),
					high: pct(b.high),
					low: pct(b.low),
					close: pct(b.close),
					...(b.average === undefined
						? {}
						: { average: b.average === null ? null : pct(b.average) }),
				})),
			});
		},
	);
}
