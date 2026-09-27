/** 古いデータの保持期間（日）。null は削除しない */
export type RetentionSettings = {
	/** 自動取引の判断の記録。注文を出した判断は期間を過ぎても残す */
	decisionsDays: number | null;
	/** バックテストの実行（結果・アドバイスごと）。実行を始めた時刻で数える */
	backtestsDays: number | null;
};

/** 1回の削除の結果 */
export type RetentionRun = {
	at: number;
	decisions: number;
	backtests: number;
	/** 失敗したときの理由 */
	error: string | null;
};

export type RetentionTable = {
	name: string;
	label: string;
	rows: number;
};

export type RetentionStatus = {
	settings: RetentionSettings;
	lastRun: RetentionRun | null;
	nextRunAt: number;
	running: boolean;
	/** DB ファイルの大きさ（バイト） */
	dbBytes: number;
	/** そのうち削除で空いて、次の書き込みで再利用される領域 */
	freeBytes: number;
	tables: RetentionTable[];
};

export type SetRetentionResult =
	| { ok: true; settings: RetentionSettings }
	| { ok: false; message: string; field: keyof RetentionSettings };

export type RetentionService = {
	status(): RetentionStatus;
	setSettings(input: RetentionSettings): SetRetentionResult;
};
