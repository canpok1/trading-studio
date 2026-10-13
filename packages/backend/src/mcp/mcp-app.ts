// ローカルの Claude Code から戦略とニュースの採点を相談するための MCP（Streamable HTTP）。docs/mcp.md
// 自動取引のオンオフ・運用する戦略の切替と変更・削除・設定は道具にしない（画面から人が行う）。運用の結果は読める。
// 例外は採点の基準の版の保存と切替（docs/adr/0013）

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { registerAdviceTools } from "../advice/mcp-app";
import { registerBacktestTools } from "../backtests/mcp-app";
import { registerDatasetTools } from "../datasets/mcp-app";
import { registerJudgmentTools } from "../judgments/mcp-app";
import { registerMarketTools } from "../market/mcp-app";
import { registerMarketDataTools } from "../market-data/mcp-app";
import { registerNewsTools } from "../news/mcp-app";
import { registerScoringAnalysisTools } from "../scoring-analysis/mcp-app";
import { registerSegmentTools } from "../segments/mcp-app";
import { registerStrategyTools } from "../strategies/mcp-app";
import { registerTradingTools } from "../trading/mcp-app";
import type { McpDeps, ToolDeps } from "./tool-app";
import { BACKTEST_WAIT_MS } from "./tool-app";

function createServer(input: McpDeps) {
	const deps: ToolDeps = {
		...input,
		backtestWaitMs: input.backtestWaitMs ?? BACKTEST_WAIT_MS,
		sleep: input.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
	};
	const server = new McpServer(
		{ name: "trading-studio", version: "1.0.0" },
		{
			instructions:
				"BTC/JPY の自動売買アプリ trading-studio。戦略の条件と、ニュースの AI 採点の基準を相談して改良するための道具。戦略: まず get_guide で条件セットの書き方を読む。戦略の新規作成・運用中でない戦略の条件変更・バックテストの実行ができる。自動取引のオンオフや運用する戦略の切替・変更はできない（画面で人が行う）。運用の結果は list_trading_runs・list_trading_orders・get_strategy_watch、価格は get_market_price・get_price_bars で読める。採点: get_scoring_setup で仕組みと今の基準を読み、get_market_evaluation で市場評価とその内訳を、get_market_evaluation_analysis で採点がその後の値動きと合っていたか（精度）の集計を、list_news_scores で記事ごとの採点と精度を見て、trial_scoring で基準の案を過去のニュースに試し、add_scoring_criteria で版として保存し、rescore_news と run_backtest の criteriaVersion でその版の成績を確かめ、set_active_scoring_criteria で使い始める。切り替えると次に採点するニュースから効き、自動取引の判定にも効くので、切り替える前に利用者に確認を取る。",
		},
	);

	registerStrategyTools(server, deps);
	registerMarketDataTools(server, deps);
	registerSegmentTools(server, deps);
	registerBacktestTools(server, deps);
	registerAdviceTools(server, deps);
	registerDatasetTools(server, deps);
	registerTradingTools(server, deps);
	registerMarketTools(server, deps);
	registerNewsTools(server, deps);
	registerJudgmentTools(server, deps);
	registerScoringAnalysisTools(server, deps);
	return server;
}

/** /mcp に置く。セッションを持たず、要求ごとにサーバーを作る */
export function mcpRoutes(deps: McpDeps) {
	return new Hono().all("/", async (c) => {
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		const server = createServer(deps);
		await server.connect(transport);
		return transport.handleRequest(c.req.raw);
	});
}
