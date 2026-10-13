// MCP の道具のうち、market の機能のもの

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { timeframeSchema } from "../mcp/schemas-domain";
import type { ToolDeps } from "../mcp/tool-app";
import { fail, readOnly, text } from "../mcp/tool-app";
import { barsView, jst } from "../mcp/views-domain";

/** get_price_bars で一度に返す足の上限 */
export const BARS_MAX = 2_000;

export function registerMarketTools(
	server: McpServer,
	{ judgments, market }: ToolDeps,
) {
	server.registerTool(
		"get_market_price",
		{
			description:
				"BTC/JPY の現在値（直近の約定の価格）・その時刻・24時間前の価格と変化率（%）、価格の収集の状態（止まっていれば理由と再接続の予定）。ホームのチャートの上端の値と同じ",
			annotations: readOnly,
		},
		() => {
			const m = market.latest();
			const c = m.collector;
			return text({
				price: m.price,
				priceTime: m.priceTime === null ? null : jst(m.priceTime),
				price24hAgo: m.price24hAgo,
				changePercent24h:
					m.price === null || m.price24hAgo === null || m.price24hAgo === 0
						? null
						: Math.round((m.price / m.price24hAgo - 1) * 10_000) / 100,
				collector: {
					state: c.state,
					error: c.error,
					stoppedSince: c.stoppedSince === null ? null : jst(c.stoppedSince),
					retryAt: c.retryAt === null ? null : jst(c.retryAt),
				},
			});
		},
	);

	server.registerTool(
		"get_price_bars",
		{
			description:
				"ホームのチャートの足（始値・高値・安値・終値・出来高）と、足ごとの市場評価（チャートの背景。採点の記録の前は null）。期間の中の新しいほうから limit 本を古い順で返す。volume は satoshi。最新の価格は get_market_price",
			inputSchema: {
				timeframe: timeframeSchema,
				range: z
					.enum(["1d", "1w", "1m", "all"])
					.default("1w")
					.describe("1d=1日・1w=1週間・1m=30日・all=全期間"),
				limit: z.number().int().min(1).max(BARS_MAX).default(200),
			},
			annotations: readOnly,
		},
		({ timeframe, range, limit }) => {
			const r = market.bars(timeframe, range, 0);
			if (!r.ok) {
				return fail(
					`足が多すぎる（${r.count}本。上限 ${r.max}本）。期間を短くするか粗い粒度にする`,
				);
			}
			return text(barsView(r.bars, limit, timeframe, judgments));
		},
	);
}
