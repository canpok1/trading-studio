import {
	blob,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
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

/** 相場データ。足は写さず、期間と相場のラベルだけを持つ。毎月、直近2か月ぶんを作る */
export const segments = sqliteTable(
	"segments",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		/** 期間（to は含まない）。JST の月初 */
		fromTime: integer("from_time").notNull(),
		toTime: integer("to_time").notNull(),
		/** 相場（up / down / range / volatile） */
		regime: text("regime").notNull(),
		/** 期間の騰落率（ppm） */
		returnPpm: integer("return_ppm").notNull(),
		/** 日ごとの騰落率の標準偏差（ppm） */
		volatilityPpm: integer("volatility_ppm").notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(t) => [uniqueIndex("segments_period").on(t.fromTime, t.toTime)],
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
	/** 使わない。バックテストが戦略と結び付いていた頃の元の戦略 */
	strategyId: integer("strategy_id"),
	/** バックテスト名。戦略と結び付いていた頃の実行は、実行したときの戦略名 */
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
	/** 市場評価に使った採点の基準の版。null は運用どおり（記事ごとに運用で採点した版） */
	criteriaVersion: integer("criteria_version"),
	/** 記事を公開から何ミリ秒遅れて使ったか。市場評価の条件が無い実行と、この列を足す前の実行（運用の採点時刻から使っていた）は null */
	newsDelayMs: integer("news_delay_ms"),
	/** 使ったニュースのデータの版（記事の取得・採点・採点し直し・置き換えのうち最新の時刻）。記事が無い・この列を足す前の実行は null */
	newsDataVersion: integer("news_data_version"),
	/** 期間を相場データで選んだときの相場データ。期間を指定した実行・この列を足す前の実行は null。相場データを消しても残す */
	segmentId: integer("segment_id"),
	/** そのときの相場データの相場（up / down / range / volatile） */
	segmentRegime: text("segment_regime"),
	/** データセットでまとめて実行したときの、まとめた実行。単独の実行は null */
	datasetRunId: integer("dataset_run_id"),
});

/** データセット。相場データを名前を付けてまとめたもの。中身は保存したまま変えない */
export const datasets = sqliteTable("datasets", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	name: text("name").notNull().unique(),
	/** 相場データの id（JSON の配列）。消えた相場データの id も残し、読むときに除く */
	segmentIds: text("segment_ids").notNull(),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

/** データセットのまとめた実行。相場データごとの実行は backtest_runs が dataset_run_id で指す */
export const datasetRuns = sqliteTable("dataset_runs", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	/** 元のデータセット。データセットを消しても残す */
	datasetId: integer("dataset_id").notNull(),
	/** 実行したときのデータセット名 */
	datasetName: text("dataset_name").notNull(),
	/** バックテスト名 */
	name: text("name").notNull(),
	/** 実行する順の相場データの id（JSON の配列） */
	segmentIds: text("segment_ids").notNull(),
	/** 実行の条件（JSON）。相場データごとの実行を順に始めるのに使う */
	input: text("input").notNull(),
	/** running / done / failed / canceled */
	status: text("status").notNull(),
	startedAt: integer("started_at").notNull(),
	finishedAt: integer("finished_at"),
	/** 合算した成績（JSON）。完了したときだけ入る */
	summary: text("summary"),
	error: text("error"),
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

/** ニュース。保持期間を過ぎたら消す（retention） */
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

/** ニュースの採点結果。1件のニュースに1行。ニュースと一緒に消す */
export const newsScores = sqliteTable(
	"news_scores",
	{
		newsId: integer("news_id")
			.primaryKey()
			.references(() => news.id),
		/** done: 採点済み / retry: 再試行を待っている / failed: 採点に失敗 / skipped: 古いので採点しない */
		status: text("status").notNull(),
		/** 観点ごとの点数（sentiment は -100〜100 で 0 が中立、risk は 0〜100）。関係ない観点は 0。採点済みでなければ null */
		risk: integer("risk"),
		sentiment: integer("sentiment"),
		/** 影響の持続（none・short・medium・long）。採点済みでなければ null */
		duration: text("duration"),
		comment: text("comment"),
		/** 採点した時刻。運用の判定ではこれより前には使わない。採点し直して置き換えても変えない */
		scoredAt: integer("scored_at"),
		/** 採点し直して点数を置き換えた時刻（記録用）。置き換えていなければ null */
		rescoredAt: integer("rescored_at"),
		criteriaVersion: integer("criteria_version"),
		model: text("model"),
		/** 採点したアプリのバージョン（ビルド日時）。開発版と記録前の採点は null */
		appBuiltAt: integer("app_built_at"),
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

/**
 * 過去のニュースを採点の基準の版を指定して採点し直した結果。1件のニュースと版の組に1行。
 * バックテスト用に頼んだものは運用の採点（news_scores）を上書きしない。ニュース画面から頼んだもの（replace_requested_at あり）は、
 * 採点し直したら運用の採点を置き換え、元の採点をその版の行としてここへ残す
 */
export const newsRescores = sqliteTable(
	"news_rescores",
	{
		newsId: integer("news_id")
			.notNull()
			.references(() => news.id),
		criteriaVersion: integer("criteria_version").notNull(),
		/** queued: 採点を待っている / retry: 再試行を待っている / done: 採点済み / failed: 採点に失敗 */
		status: text("status").notNull(),
		risk: integer("risk"),
		sentiment: integer("sentiment"),
		duration: text("duration"),
		comment: text("comment"),
		/** 採点し直した時刻（記録用。判定には使わない） */
		scoredAt: integer("scored_at"),
		model: text("model"),
		appBuiltAt: integer("app_built_at"),
		error: text("error"),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: integer("next_attempt_at"),
		/** 採点し直しを頼んだ時刻。この順に採点する */
		requestedAt: integer("requested_at").notNull(),
		/**
		 * ニュース画面から運用の採点（news_scores）の置き換えを頼んだ時刻。採点し直したら、これより後に頼んだ置き換えが無ければ置き換える。
		 * 頼んでいないか、置き換えた・後の頼みに置き換わった後は null
		 */
		replaceRequestedAt: integer("replace_requested_at"),
	},
	(t) => [
		primaryKey({ columns: [t.newsId, t.criteriaVersion] }),
		index("news_rescores_status").on(t.status),
	],
);

/**
 * 自動取引の運用。ホームのタブ1つ。モード・戦略・口座・実行状態を運用ごとに持つ。
 * 削除しても注文・判断の記録から名前を引けるよう、行は消さずに deleted_at を入れる
 */
export const tradingRuns = sqliteTable("trading_runs", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	name: text("name").notNull(),
	/** paper / live */
	mode: text("mode").notNull(),
	/** 運用する戦略。オン中は動かしている戦略。戦略を削除しても残るので外部キーにしない */
	strategyId: integer("strategy_id"),
	createdAt: integer("created_at").notNull(),
	deletedAt: integer("deleted_at"),
	enabled: integer("enabled", { mode: "boolean" }).notNull(),
	/** 戦略の state（JSON） */
	state: text("state").notNull(),
	/** 次の判定時刻。オフなら null */
	nextEvalAt: integer("next_eval_at"),
	/** 約定があったので次の見回りで評価し直す */
	reevaluate: integer("reevaluate", { mode: "boolean" }).notNull(),
	startedAt: integer("started_at"),
	/** 開始時の資金（リセットで戻す額） */
	initialCash: integer("initial_cash").notNull(),
	/** 口座（JSON: core の Account。現金・保有・未約定の注文）。null は開始時の資金だけの口座 */
	account: text("account"),
	/** 最後にリセットした時刻。作ったときは作った時刻 */
	resetAt: integer("reset_at").notNull(),
});

/** 自動取引の注文。発注から約定・取消までを1行で持つ。削除しない */
export const tradingOrders = sqliteTable(
	"trading_orders",
	{
		/** 運用（trading_runs）の id */
		runId: integer("run_id").notNull(),
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
		/** 売りを出した条件のグループ（takeProfit / stopLoss）。買いと、この列を足す前の売りは null */
		exitKind: text("exit_kind"),
		/** 買いを出した買いの名前。売りと、買いが1つの戦略の買いは null */
		buyName: text("buy_name"),
		/** 発注した判断。戦略を削除しても注文は残すので外部キーにしない */
		decisionId: integer("decision_id"),
		strategyId: integer("strategy_id"),
		strategyName: text("strategy_name").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.runId, t.id] }),
		index("trading_orders_placed_at").on(t.placedAt),
	],
);

/** 自動取引の判断の記録。評価のたびに1行。保持期間を過ぎたものは消す（注文を出した判断は残す） */
export const tradingDecisions = sqliteTable(
	"trading_decisions",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		runId: integer("run_id").notNull(),
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

/** バックテストのアドバイスの指示の版。上書きせず、版を足していく */
export const adviceInstructions = sqliteTable("advice_instructions", {
	version: integer("version").primaryKey({ autoIncrement: true }),
	text: text("text").notNull(),
	/** 版の説明 */
	note: text("note").notNull(),
	createdAt: integer("created_at").notNull(),
});

/** バックテストの AI アドバイス。実行ごとに最新の1件だけ持ち、生成し直すと置き換える */
export const backtestAdvice = sqliteTable("backtest_advice", {
	runId: integer("run_id")
		.primaryKey()
		.references(() => backtestRuns.id),
	/** running / done / failed */
	status: text("status").notNull(),
	/** アドバイスの本文（JSON: 見出しごとの文章）。作り直しの生成中と失敗では前の本文を残す */
	content: text("content"),
	model: text("model").notNull(),
	instructionsVersion: integer("instructions_version").notNull(),
	/** 生成したアプリのバージョン（ビルド日時）。開発版は null */
	appBuiltAt: integer("app_built_at"),
	startedAt: integer("started_at").notNull(),
	/** 本文を作り終えた時刻 */
	finishedAt: integer("finished_at"),
	error: text("error"),
});
