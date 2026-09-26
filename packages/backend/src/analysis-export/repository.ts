// 分析用エクスポートで読む記録。読むだけで書き換えない

import type { Db } from "../db/open";

export type NewsExportRow = {
	id: number;
	source_id: number;
	source_name: string;
	language: string;
	url: string;
	title: string;
	summary: string | null;
	published_at: number;
	fetched_at: number;
	/** 採点の行が無ければ null */
	status: string | null;
	trend: number | null;
	risk: number | null;
	sentiment: number | null;
	comment: string | null;
	scored_at: number | null;
	criteria_version: number | null;
	model: string | null;
	error: string | null;
	attempts: number | null;
};

export type StrategyExportRow = {
	id: number;
	name: string;
	params: string;
	created_at: number;
	updated_at: number;
};

export type DecisionExportRow = {
	id: number;
	mode: string;
	strategy_id: number | null;
	strategy_name: string;
	time: number;
	decision: string;
	judgments: string;
};

export type OrderExportRow = {
	mode: string;
	id: string;
	side: string;
	type: string;
	price: number | null;
	quantity: number;
	placed_at: number;
	status: string;
	filled_at: number | null;
	fill_price: number | null;
	fee: number | null;
	canceled_at: number | null;
	cancel_reason: string | null;
	reason: string;
	pair_id: string | null;
	pnl: number | null;
	decision_id: number | null;
	strategy_id: number | null;
	strategy_name: string;
};

export class AnalysisExportRepository {
	constructor(private readonly db: Db) {}

	private get sql() {
		return this.db.$client;
	}

	/** 新しさの時刻（公開時刻と取得時刻の早いほう）が [from, to) のニュースと採点。採点していないものも入れる */
	news(from: number, to: number): NewsExportRow[] {
		return this.sql
			.query<NewsExportRow, [number, number]>(
				`select n.id, n.source_id, n.source_name, n.language, n.url, n.title, n.summary,
				   n.published_at, n.fetched_at, s.status, s.trend, s.risk, s.sentiment, s.comment,
				   s.scored_at, s.criteria_version, s.model, s.error, s.attempts
				 from news n left join news_scores s on s.news_id = n.id
				 where min(n.published_at, n.fetched_at) >= ? and min(n.published_at, n.fetched_at) < ?
				 order by min(n.published_at, n.fetched_at), n.id`,
			)
			.all(from, to);
	}

	strategies(): StrategyExportRow[] {
		return this.sql
			.query<StrategyExportRow, []>(
				"select id, name, params, created_at, updated_at from strategies order by id",
			)
			.all();
	}

	/** 自動取引の判断の記録。時刻が [from, to) のもの */
	decisions(from: number, to: number): DecisionExportRow[] {
		return this.sql
			.query<DecisionExportRow, [number, number]>(
				"select * from trading_decisions where time >= ? and time < ? order by time, id",
			)
			.all(from, to);
	}

	/** 自動取引の注文。発注時刻が [from, to) のもの */
	orders(from: number, to: number): OrderExportRow[] {
		return this.sql
			.query<OrderExportRow, [number, number]>(
				"select * from trading_orders where placed_at >= ? and placed_at < ? order by placed_at, id",
			)
			.all(from, to);
	}
}
