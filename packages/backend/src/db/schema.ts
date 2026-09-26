import {
	blob,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
});

/** 過去データの取り込み。1回の取り込みが1行 */
export const dataImports = sqliteTable("data_imports", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	timeframe: text("timeframe").notNull(),
	fileName: text("file_name").notNull(),
	/** running / done / failed / canceled */
	status: text("status").notNull(),
	startedAt: integer("started_at").notNull(),
	finishedAt: integer("finished_at"),
	totalRows: integer("total_rows").notNull().default(0),
	/** 保存した行数 */
	insertedRows: integer("inserted_rows").notNull().default(0),
	/** 同じ粒度・同じ日時の足があったので保存しなかった行数（ファイル内の重複を含む） */
	skippedRows: integer("skipped_rows").notNull().default(0),
	/** 自動で作った粗い粒度の足の数 */
	derivedRows: integer("derived_rows").notNull().default(0),
	firstTime: integer("first_time"),
	lastTime: integer("last_time"),
	/** 失敗したときの理由（JSON: { message, errors, errorCount }） */
	error: text("error"),
});

/** 足。金額は円、出来高は satoshi、時刻は足の開始時刻（UTC のエポックミリ秒） */
export const candles = sqliteTable(
	"candles",
	{
		timeframe: text("timeframe").notNull(),
		time: integer("time").notNull(),
		open: integer("open").notNull(),
		high: integer("high").notNull(),
		low: integer("low").notNull(),
		close: integer("close").notNull(),
		volume: integer("volume").notNull(),
		/** import: CSV から取り込んだ / collect: 収集した / derived: 細かい足から作った */
		source: text("source").notNull(),
		importId: integer("import_id").references(() => dataImports.id),
	},
	(t) => [
		primaryKey({ columns: [t.timeframe, t.time] }),
		index("candles_import_id").on(t.importId),
	],
);

/** 戦略（名前を付けた条件のセット） */
export const strategies = sqliteTable("strategies", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	name: text("name").notNull().unique(),
	/** 条件のセット（JSON） */
	params: text("params").notNull(),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

/** バックテストの実行。実行時の条件の写しと成績を持つ */
export const backtestRuns = sqliteTable("backtest_runs", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	/** 元の戦略。戦略を削除しても実行は残すので外部キーにしない */
	strategyId: integer("strategy_id"),
	/** 実行したときの戦略名 */
	strategyName: text("strategy_name").notNull(),
	/** 条件のセット（JSON） */
	params: text("params").notNull(),
	timeframe: text("timeframe").notNull(),
	/** 期間（to は含まない） */
	fromTime: integer("from_time").notNull(),
	toTime: integer("to_time").notNull(),
	initialCash: integer("initial_cash").notNull(),
	feeLimitPpm: integer("fee_limit_ppm").notNull(),
	feeMarketPpm: integer("fee_market_ppm").notNull(),
	/** 期間内の欠損を承知で実行したか */
	skipGaps: integer("skip_gaps", { mode: "boolean" }).notNull(),
	/** running / done / failed / canceled */
	status: text("status").notNull(),
	startedAt: integer("started_at").notNull(),
	finishedAt: integer("finished_at"),
	/** 期間内の足の数 */
	barCount: integer("bar_count").notNull(),
	/** 判定と約定に使った足の粒度。この列を足す前の実行は null（戦略の粒度で進めていた） */
	stepTimeframe: text("step_timeframe"),
	/** データが足りず、判定頻度より粗い間隔でしか判定できなかったか */
	stepLimited: integer("step_limited", { mode: "boolean" })
		.notNull()
		.default(false),
	/** 成績（JSON）。完了したときだけ入る */
	summary: text("summary"),
	/** 約定の数・注文の数 */
	filledCount: integer("filled_count").notNull().default(0),
	orderCount: integer("order_count").notNull().default(0),
	error: text("error"),
	/** 実行したときの AI 判定の集計ルール（JSON）。この列を足す前の実行は null */
	aggregationRule: text("aggregation_rule"),
});

/** バックテストの結果の中身。大きいので gzip した JSON で持つ */
export const backtestResults = sqliteTable("backtest_results", {
	runId: integer("run_id")
		.primaryKey()
		.references(() => backtestRuns.id),
	/** 期間内の足 { times, closes, opens, highs, lows }。opens・highs・lows は4本値を保存する前の実行には無い */
	bars: blob("bars", { mode: "buffer" }).notNull(),
	orders: blob("orders", { mode: "buffer" }).notNull(),
	trades: blob("trades", { mode: "buffer" }).notNull(),
	decisions: blob("decisions", { mode: "buffer" }).notNull(),
});

/** ニュースの取得元（RSS） */
export const newsSources = sqliteTable("news_sources", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	name: text("name").notNull(),
	url: text("url").notNull().unique(),
	/** ja / en */
	language: text("language").notNull(),
	enabled: integer("enabled", { mode: "boolean" }).notNull(),
	createdAt: integer("created_at").notNull(),
	lastSuccessAt: integer("last_success_at"),
	/** 直近の取得の失敗理由。成功したら null に戻す */
	lastError: text("last_error"),
	/** 失敗が続いている最初の時刻 */
	errorSince: integer("error_since"),
});

/** ニュース。削除しない（バックテストの材料のため） */
export const news = sqliteTable(
	"news",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		/** 取得元を削除してもニュースは残すので外部キーにしない */
		sourceId: integer("source_id").notNull(),
		/** 取得したときの取得元の名前 */
		sourceName: text("source_name").notNull(),
		language: text("language").notNull(),
		url: text("url").notNull().unique(),
		title: text("title").notNull(),
		summary: text("summary"),
		/** RSS の公開時刻。無ければ取得時刻 */
		publishedAt: integer("published_at").notNull(),
		fetchedAt: integer("fetched_at").notNull(),
	},
	(t) => [index("news_published_at").on(t.publishedAt)],
);

/** 採点の基準の版。上書きせず、版を足していく */
export const scoringCriteria = sqliteTable("scoring_criteria", {
	version: integer("version").primaryKey({ autoIncrement: true }),
	text: text("text").notNull(),
	/** 版の説明 */
	note: text("note").notNull(),
	createdAt: integer("created_at").notNull(),
});

/** ニュースの採点結果。1件のニュースに1行。削除しない */
export const newsScores = sqliteTable(
	"news_scores",
	{
		newsId: integer("news_id")
			.primaryKey()
			.references(() => news.id),
		/** done: 採点済み / retry: 再試行を待っている / failed: 採点に失敗 / skipped: 古いので採点しない */
		status: text("status").notNull(),
		/** 観点ごとの点数（0〜100）。関係なしは null */
		trend: integer("trend"),
		risk: integer("risk"),
		sentiment: integer("sentiment"),
		comment: text("comment"),
		/** 採点した時刻。これより前の判定には使わない */
		scoredAt: integer("scored_at"),
		criteriaVersion: integer("criteria_version"),
		model: text("model"),
		/** 最後の失敗の理由 */
		error: text("error"),
		/** 失敗した回数（手動の再試行で 0 に戻す） */
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: integer("next_attempt_at"),
	},
	(t) => [
		index("news_scores_status").on(t.status),
		index("news_scores_scored_at").on(t.scoredAt),
	],
);

/** 自動取引の口座。モードごとに1行（フェーズ4ではペーパーだけ） */
export const tradingAccounts = sqliteTable("trading_accounts", {
	/** paper / live */
	mode: text("mode").primaryKey(),
	/** 開始時の資金（リセットで戻す額） */
	initialCash: integer("initial_cash").notNull(),
	/** 口座（JSON: core の Account。現金・保有・未約定の注文） */
	account: text("account").notNull(),
	/** 最後にリセットした時刻。作ったときは作った時刻 */
	resetAt: integer("reset_at").notNull(),
});

/** 自動取引の注文。発注から約定・取消までを1行で持つ。削除しない */
export const tradingOrders = sqliteTable(
	"trading_orders",
	{
		mode: text("mode").notNull(),
		id: text("id").notNull(),
		side: text("side").notNull(),
		type: text("type").notNull(),
		price: integer("price"),
		quantity: integer("quantity").notNull(),
		placedAt: integer("placed_at").notNull(),
		/** open / filled / canceled */
		status: text("status").notNull(),
		filledAt: integer("filled_at"),
		fillPrice: integer("fill_price"),
		fee: integer("fee"),
		canceledAt: integer("canceled_at"),
		cancelReason: text("cancel_reason"),
		reason: text("reason").notNull(),
		pairId: text("pair_id"),
		pnl: integer("pnl"),
		/** 発注した判断。戦略を削除しても注文は残すので外部キーにしない */
		decisionId: integer("decision_id"),
		strategyId: integer("strategy_id"),
		strategyName: text("strategy_name").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.mode, t.id] }),
		index("trading_orders_placed_at").on(t.placedAt),
	],
);

/** 自動取引の判断の記録。評価のたびに1行。削除しない */
export const tradingDecisions = sqliteTable(
	"trading_decisions",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		mode: text("mode").notNull(),
		strategyId: integer("strategy_id"),
		strategyName: text("strategy_name").notNull(),
		time: integer("time").notNull(),
		/** 判断の記録（JSON: core の DecisionLog） */
		decision: text("decision").notNull(),
		/** そのときの AI 判定（JSON: 判定器 → 値）。判定器を使わない戦略では空 */
		judgments: text("judgments").notNull(),
	},
	(t) => [index("trading_decisions_time").on(t.time)],
);

/** 自動取引の実行状態。1行だけ持つ */
export const autoTrading = sqliteTable("auto_trading", {
	id: integer("id").primaryKey(),
	enabled: integer("enabled", { mode: "boolean" }).notNull(),
	/** paper / live */
	mode: text("mode").notNull(),
	/** 動かしている戦略。オンにしたときの運用する戦略 */
	strategyId: integer("strategy_id"),
	/** 戦略の state（JSON） */
	state: text("state").notNull(),
	/** 次の判定時刻。オフなら null */
	nextEvalAt: integer("next_eval_at"),
	/** 約定があったので次の見回りで評価し直す */
	reevaluate: integer("reevaluate", { mode: "boolean" }).notNull(),
	startedAt: integer("started_at"),
});
