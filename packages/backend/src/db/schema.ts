import {
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
		/** import: CSV から取り込んだ / derived: 細かい足から作った */
		source: text("source").notNull(),
		importId: integer("import_id").references(() => dataImports.id),
	},
	(t) => [
		primaryKey({ columns: [t.timeframe, t.time] }),
		index("candles_import_id").on(t.importId),
	],
);
