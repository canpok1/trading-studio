// MCP の道具のうち、trading の機能のもの。サーバーへの登録は mcp/mcp-app.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import type { McpDeps } from "../mcp/tool-app";
import { fail, readOnly, text } from "../mcp/tool-app";
import {
	hidden,
	judgmentsView,
	paperView,
	tradingOrderView,
	tradingRunView,
	watchView,
} from "../mcp/views-domain";

export function registerTradingTools(
	server: McpServer,
	{ trading, market }: McpDeps,
) {
	server.registerTool(
		"list_trading_runs",
		{
			description:
				"ホームのタブ（運用）の一覧（作った順）。モード（paper=デモ・live=リアル）・稼働中か・運用する戦略・次の判定時刻・今日の確定損失と1日の損失上限。デモは口座（現金・保有・ロットごとの含み損益）・含み損益・口座のリセット以降の成績（通算損益・ガチホ・勝率など。画面と同じ5段階の評価付き）も返す。リアルは画面と同じく口座と成績を出さない。オンオフ・戦略の切替は画面から人が行う",
			annotations: readOnly,
		},
		() => {
			const price = market.latest().price;
			return text(
				trading.runs().map((r) => ({
					...tradingRunView(r),
					...(hidden(r) ? {} : paperView(r, price, trading.performance(r.id))),
				})),
			);
		},
	);

	server.registerTool(
		"get_strategy_watch",
		{
			description:
				"ホームの「次の動き」「戦略の見張り」。タブで運用する戦略を今の価格で試算した、買いとロットごとの条件の成立・今の値・発動価格（価格がいくらになれば成立するか）。actions は起きうる売買で、price が null なら今の価格のまま次の判定で起きる。nextMoves は画面の「次の動き」（次の判定で起きるものと、上側・下側それぞれ最も近い発動価格）。distancePercent は今の価格からの幅。注文はしない。リアルのタブは画面と同じく出さない",
			inputSchema: {
				runId: z.number().int().describe("タブ（list_trading_runs）"),
			},
			annotations: readOnly,
		},
		({ runId }) => {
			const run = trading.run(runId);
			if (!run) return fail("タブが見つからない");
			if (hidden(run)) return fail("リアルのタブは戦略の見張りを出さない");
			const w = trading.watch(runId)?.watch ?? null;
			return w
				? text(watchView(w))
				: fail("運用する戦略を選んでいないか、価格がまだ無い");
		},
	);

	server.registerTool(
		"list_trading_orders",
		{
			description:
				"タブ（運用）の注文・約定（新しい順）。発注の理由・約定・往復の損益（売りの pnl、手数料込み）・売りのロットの買値と利確/損切りの別（exitKind）・発注したときの市場評価（judgments）を含む。total と realizedPnl は件数で切らずに数えた件数と損益の合計。リアルのタブは画面と同じく出さない",
			inputSchema: {
				runId: z.number().int().describe("タブ（list_trading_runs）"),
				status: z
					.enum(["open", "filled", "canceled"])
					.optional()
					.describe("open=未約定・filled=約定・canceled=取消。省けばすべて"),
				side: z.enum(["buy", "sell"]).optional(),
				limit: z.number().int().min(1).max(500).default(100),
			},
			annotations: readOnly,
		},
		({ runId, status, side, limit }) => {
			const run = trading.run(runId);
			if (!run) return fail("タブが見つからない");
			if (hidden(run)) return fail("リアルのタブは注文・約定を出さない");
			const filter = { runId, status, side };
			const summary = trading.orderSummary(filter);
			return text({
				total: summary.count,
				realizedPnl: summary.realizedPnl,
				orders: trading.orders(filter, limit).map((o) => ({
					...tradingOrderView(o),
					judgments: judgmentsView(
						trading.order(runId, o.id)?.decision?.judgments,
					),
				})),
			});
		},
	);
}
