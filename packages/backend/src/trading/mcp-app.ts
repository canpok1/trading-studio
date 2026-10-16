// MCP の道具のうち、trading の機能のもの

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import type { ToolDeps } from "../mcp/tool-app";
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
	{ trading, market }: ToolDeps,
) {
	server.registerTool(
		"list_auto_trading",
		{
			description:
				"戦略ごとの自動取引の一覧（戦略を作った順。id は戦略の id）。戦略1つが口座1つを持つ。モード（今は paper=デモだけ）・稼働中か・次の判定時刻・今日の確定損失と1日の損失上限。デモは口座（現金・保有・ロットごとの含み損益）・含み損益・口座のリセット以降の成績（通算損益・ガチホ・勝率など。画面と同じ5段階の評価付き）も返す。リアルは画面と同じく口座と成績を出さない。オンオフは画面から人が行う",
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
				"ホームの「次の動き」「戦略の見張り」。戦略を今の価格で試算した、買いとロットごとの条件の成立・今の値・発動価格（価格がいくらになれば成立するか）。actions は起きうる売買で、price が null なら今の価格のまま次の判定で起きる。nextMoves は画面の「次の動き」（次の判定で起きるものと、上側・下側それぞれ最も近い発動価格）。distancePercent は今の価格からの幅。注文はしない。リアルは画面と同じく出さない",
			inputSchema: {
				strategyId: z.number().int().describe("戦略の id（list_strategies）"),
			},
			annotations: readOnly,
		},
		({ strategyId }) => {
			const run = trading.run(strategyId);
			if (!run) return fail("戦略が見つからない");
			if (hidden(run)) return fail("リアルは戦略の見張りを出さない");
			const w = trading.watch(strategyId)?.watch ?? null;
			return w ? text(watchView(w)) : fail("価格がまだ無い");
		},
	);

	server.registerTool(
		"list_trading_orders",
		{
			description:
				"戦略の自動取引の注文・約定（新しい順）。発注の理由・約定・往復の損益（売りの pnl、手数料込み）・売りのロットの買値と利確/損切りの別（exitKind）・発注したときの市場評価（judgments）を含む。total と realizedPnl は件数で切らずに数えた件数と損益の合計。リアルは画面と同じく出さない",
			inputSchema: {
				strategyId: z.number().int().describe("戦略の id（list_strategies）"),
				status: z
					.enum(["open", "filled", "canceled"])
					.optional()
					.describe("open=未約定・filled=約定・canceled=取消。省けばすべて"),
				side: z.enum(["buy", "sell"]).optional(),
				limit: z.number().int().min(1).max(500).default(100),
			},
			annotations: readOnly,
		},
		({ strategyId, status, side, limit }) => {
			const run = trading.run(strategyId);
			if (!run) return fail("戦略が見つからない");
			if (hidden(run)) return fail("リアルは注文・約定を出さない");
			const filter = { strategyId, status, side };
			const summary = trading.orderSummary(filter);
			return text({
				total: summary.count,
				realizedPnl: summary.realizedPnl,
				orders: trading.orders(filter, limit).map((o) => ({
					...tradingOrderView(o),
					judgments: judgmentsView(
						trading.order(strategyId, o.id)?.decision?.judgments,
					),
				})),
			});
		},
	);
}
