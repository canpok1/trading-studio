export interface AnalysisExportRepository {
	/** 新しさの時刻（公開時刻と取得時刻の早いほう）が [from, to) のニュースと採点。採点していないものも入れる */
	news(from: number, to: number): NewsExportRow[];
	strategies(): StrategyExportRow[];
	/** 自動取引の判断の記録。時刻が [from, to) のもの */
	decisions(from: number, to: number): DecisionExportRow[];
	/** 自動取引の注文。発注時刻が [from, to) のもの */
	orders(from: number, to: number): OrderExportRow[];
}

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
	risk: number | null;
	sentiment: number | null;
	duration: string | null;
	comment: string | null;
	scored_at: number | null;
	criteria_version: number | null;
	model: string | null;
	app_built_at: number | null;
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
	run_id: number;
	run_name: string | null;
	mode: string;
	strategy_id: number | null;
	strategy_name: string;
	time: number;
	decision: string;
	judgments: string;
};

export type OrderExportRow = {
	run_id: number;
	run_name: string | null;
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
	buy_name: string | null;
	decision_id: number | null;
	strategy_id: number | null;
	strategy_name: string;
};
