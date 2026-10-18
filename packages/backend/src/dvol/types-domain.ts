/** DVOL の1時間足。値は年率 % の ×100 の整数（55.23 → 5523） */
export type DvolBar = {
	/** 足の開始のエポックミリ秒 */
	time: number;
	open: number;
	high: number;
	low: number;
	close: number;
};

/** 取得の状態。設定の取得元タブに出す */
export type DvolStatus = {
	lastSuccessAt: number | null;
	/** 最後の取得が失敗していればその理由。成功すれば消す */
	lastError: string | null;
	/** 失敗が続いている始まり */
	errorSince: number | null;
	/** 保存した最新の足の開始時刻 */
	latestBarTime: number | null;
	nextRunAt: number | null;
	running: boolean;
};

export type DvolBarsResult =
	| { ok: true; bars: DvolBar[] }
	| { ok: false; kind: "too_many"; count: number; max: number };

export type DvolService = {
	status(): DvolStatus;
	/** 開始が [from, to) の足を古い順に */
	bars(from: number, to: number): DvolBarsResult;
};
