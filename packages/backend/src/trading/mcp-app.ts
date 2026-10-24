// MCP の道具のうち、trading の機能のもの

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { instrumentIdSchema } from "../mcp/schemas-domain";
import type { ToolDeps } from "../mcp/tool-app";
import { fail, readOnly, text } from "../mcp/tool-app";
import {
	hidden,
	judgmentsView,
	paperView,
	strategySummaryView,
	tradingOrderView,
	tradingRunView,
	watchView,
} from "../mcp/views-domain";

export function registerTradingTools(server: McpServer, { trading }: ToolDeps) {
	server.registerTool(
		"list_auto_trading",
		{
			description:
				"戦略ごとの自動取引の一覧（戦略を作った順。id は戦略の id）。戦略1つが口座1つを持つ。モード（今は paper=デモだけ）・稼働中か・次の判定時刻・今日の確定損失と1日の損失上限。デモは口座（現金・保有・ロットごとの含み損益）・含み損益・口座のリセット以降の成績（通算損益・ガチホ・勝率など。画面と同じ5段階の評価付き）も返す。リアルは画面と同じく口座と成績を出さない。オンオフは画面から人が行う",
			annotations: readOnly,
		},
		() =>
			text(
				trading.runs().map((r) => ({
					...tradingRunView(r),
					...(hidden(r) ? {} : paperView(r, trading.performance(r.id))),
				})),
			),
	);

	server.registerTool(
		"list_home_strategies",
		{
			description:
				"ホームのカード。デモで、オンか、オフでも保有か未約定の注文がある戦略の要約（作った順）。画面の「比べる値」（通算損益=performance.pnl・含み損益=unrealizedPnl・確定損益=performance.realizedPnl・勝率・PF・最大DD・取引回数）と保有ロット数、次の動き（nextMoves。get_strategy_watch と同じ形で、画面のカードは先頭の2件だけ出す。オフの戦略は判定しないので、画面では「停止中のため新しい注文は出さない」と注文中のものだけを出す）。distancePercent は今の価格からの幅。条件ごとの詳細は get_strategy_watch",
			annotations: readOnly,
		},
		() => text(trading.summaries().map(strategySummaryView)),
	);

	server.registerTool(
		"get_strategy_watch",
		{
			description:
				"戦略の画面の「次の動き」「戦略の見張り」。戦略を今の価格で試算した、買いとロットごとの条件の成立・今の値・発動価格（価格がいくらになれば成立するか）。actions は起きうる売買で、price が null なら今の価格のまま次の判定で起きる。nextMoves は画面の「次の動き」で、行動（買いごとの 買い・一部利確・利確・損切り、出している注文）ごとのきっかけを優先度の高い順に並べたもの（trigger.kind: now=次の判定で起きる・order=注文中・price=この価格で全条件が揃う・bars=あと何本・time=この時刻に予定の前後が明ける・condition=発動価格を求められない条件（市場評価・DVOL・±50% で届かない RSI など）が残り1つ・remaining=未成立が count 個）。distancePercent は今の価格からの幅。注文はしない。リアルは画面と同じく出さない",
			inputSchema: {
				strategyId: z.number().int().describe("戦略の id（list_strategies）"),
				instrument: instrumentIdSchema
					.optional()
					.describe("見張る銘柄の id。省けば候補の先頭"),
			},
			annotations: readOnly,
		},
		({ strategyId, instrument }) => {
			const run = trading.run(strategyId);
			if (!run) return fail("戦略が見つからない");
			if (hidden(run)) return fail("リアルは戦略の見張りを出さない");
			const r = trading.watch(strategyId, instrument);
			if (!r) return fail("戦略の候補に無い銘柄");
			return r.watch ? text(watchView(r.watch)) : fail("価格がまだ無い");
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
				instrument: instrumentIdSchema
					.optional()
					.describe("銘柄の id。省けばすべての銘柄"),
				limit: z.number().int().min(1).max(500).default(100),
			},
			annotations: readOnly,
		},
		({ strategyId, status, side, instrument, limit }) => {
			const run = trading.run(strategyId);
			if (!run) return fail("戦略が見つからない");
			if (hidden(run)) return fail("リアルは注文・約定を出さない");
			const filter = { strategyId, status, side, instrument };
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
