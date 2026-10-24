// 分析用エクスポートで読む記録。読むだけで書き換えない

import type { Db } from "../db/open-infra";
import type {
	AnalysisExportRepository,
	DecisionExportRow,
	NewsExportRow,
	OrderExportRow,
	StrategyExportRow,
} from "./repository-domain";

export class SqliteAnalysisExportRepository
	implements AnalysisExportRepository
{
	constructor(private readonly db: Db) {}

	private get sql() {
		return this.db.$client;
	}

	/** 新しさの時刻（公開時刻と取得時刻の早いほう）が [from, to) のニュースと採点。採点していないものも入れる */
	news(from: number, to: number): NewsExportRow[] {
		return this.sql
			.query<NewsExportRow, [number, number]>(
				`select n.id, n.source_id, n.source_name, n.language, n.url, n.title, n.summary,
				   n.published_at, n.fetched_at, s.status, s.sentiment, s.risk, s.duration, s.instruments, s.comment,
				   s.scored_at, s.criteria_version, s.model, s.app_built_at, s.error, s.attempts
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
				`select d.*, r.name as run_name from trading_decisions d left join trading_runs r on r.id = d.run_id
				where d.time >= ? and d.time < ? order by d.time, d.id`,
			)
			.all(from, to);
	}

	/** 自動取引の注文。発注時刻が [from, to) のもの */
	orders(from: number, to: number): OrderExportRow[] {
		return this.sql
			.query<OrderExportRow, [number, number]>(
				`select o.*, r.name as run_name from trading_orders o left join trading_runs r on r.id = o.run_id
				where o.placed_at >= ? and o.placed_at < ? order by o.placed_at, o.run_id, o.id`,
			)
			.all(from, to);
	}
}
