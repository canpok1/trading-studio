// ニュース収集の型。app.ts から参照されるため、Bun 固有の型を持ち込まない

export const NEWS_LANGUAGES = ["ja", "en"] as const;
export type NewsLanguage = (typeof NEWS_LANGUAGES)[number];

export type NewsSource = {
	id: number;
	name: string;
	url: string;
	language: NewsLanguage;
	enabled: boolean;
	createdAt: number;
	lastSuccessAt: number | null;
	/** 直近の取得の失敗理由。成功したら null */
	lastError: string | null;
	/** 失敗が続いている最初の時刻 */
	errorSince: number | null;
};

export type NewsItem = {
	id: number;
	sourceId: number;
	sourceName: string;
	language: NewsLanguage;
	url: string;
	title: string;
	summary: string | null;
	publishedAt: number;
	fetchedAt: number;
};

export type NewsCollectorStatus = {
	/** running: 動作中 / stopped: 有効な取得元が無いか、すべて失敗している */
	state: "running" | "stopped";
	/** 止まった理由。止まっていなければ null */
	error: string | null;
	/** 止まった時刻。止まっていなければ null */
	stoppedSince: number | null;
	intervalMinutes: number;
	/** 最後に収集を始めた時刻 */
	lastRunAt: number | null;
	/** 次に収集する時刻 */
	nextRunAt: number | null;
	sources: NewsSource[];
};

export type NewsSourceInput = {
	name: string;
	url: string;
	language: NewsLanguage;
};

export type NewsSourceResult =
	| { ok: true; source: NewsSource }
	| { ok: false; kind: "not_found" }
	| { ok: false; kind: "invalid"; field: string; message: string }
	| { ok: false; kind: "duplicate_url"; message: string };

export interface NewsService {
	listSources(): NewsSource[];
	addSource(input: NewsSourceInput): NewsSourceResult;
	updateSource(
		id: number,
		patch: { enabled?: boolean; name?: string },
	): NewsSourceResult;
	/** 取得元を消す。集めたニュースは残す */
	removeSource(id: number): boolean;
	intervalMinutes(): number;
	setIntervalMinutes(
		minutes: number,
	): { ok: true } | { ok: false; message: string };
	status(): NewsCollectorStatus;
	/** 新しい順（公開時刻） */
	listNews(limit: number): NewsItem[];
}
