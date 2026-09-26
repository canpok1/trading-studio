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
});

/** バックテストの結果の中身。大きいので gzip した JSON で持つ */
export const backtestResults = sqliteTable("backtest_results", {
	runId: integer("run_id")
		.primaryKey()
		.references(() => backtestRuns.id),
	/** 期間内の足の時刻と終値 { times, closes } */
	bars: blob("bars", { mode: "buffer" }).notNull(),
	orders: blob("orders", { mode: "buffer" }).notNull(),
	trades: blob("trades", { mode: "buffer" }).notNull(),
	decisions: blob("decisions", { mode: "buffer" }).notNull(),
});
