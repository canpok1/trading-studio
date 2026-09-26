// ニュース収集と採点の型。app.ts から参照されるため、Bun 固有の型を持ち込まない

import type { Scores } from "@trading-studio/core";

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
	/** 採点の結果。まだ採点していなければ null */
	score: NewsScore | null;
};

export type NewsScore = {
	/** done: 採点済み / retry: 再試行を待っている / failed: 採点に失敗 / skipped: 古いので採点しない */
	status: "done" | "retry" | "failed" | "skipped";
	/** 観点ごとの点数。採点済みでなければ null */
	scores: Scores | null;
	comment: string | null;
	scoredAt: number | null;
	criteriaVersion: number | null;
	model: string | null;
	/** 最後の失敗の理由 */
	error: string | null;
	/** 次に自動で再試行する時刻 */
	nextAttemptAt: number | null;
};

export type CriteriaVersion = {
	version: number;
	text: string;
	note: string;
	createdAt: number;
};

export type ScorerStatus = {
	/** running: 動作中 / stopped: API キーが無いか、直近の採点が失敗している */
	state: "running" | "stopped";
	error: string | null;
	stoppedSince: number | null;
	model: string;
	activeCriteriaVersion: number | null;
	/** 採点していないニュースの件数（再試行待ちを含む） */
	pending: number;
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

export type ScoringModelOption = { id: string; label: string };

export type TrialResult =
	| {
			ok: true;
			news: { id: number; title: string; sourceName: string };
			scores: Scores;
			comment: string;
	  }
	| { ok: false; message: string };

export type ApiKeyStatus = { configured: boolean; savedAt: number | null };

export interface ScoringService {
	status(): ScorerStatus;
	criteria(): {
		versions: CriteriaVersion[];
		activeVersion: number | null;
		/** 固定のひな形。{news} と {criteria} を差し込む */
		template: string;
	};
	addCriteria(
		text: string,
		note: string,
	): { ok: true; version: CriteriaVersion } | { ok: false; message: string };
	/** 使用する版を切り替える。採点済みのニュースは採点し直さない。版が無ければ false */
	setActiveCriteria(version: number): boolean;
	models(): { models: ScoringModelOption[]; current: string };
	/** 採点に使うモデルを変える。採点済みのニュースは採点し直さない。選べないモデルなら false */
	setModel(id: string): boolean;
	/** 保存した API キーそのものは返さない */
	apiKey(): ApiKeyStatus;
	/** 上書きする。形が不正なら理由を返す */
	setApiKey(key: string): { ok: true } | { ok: false; message: string };
	deleteApiKey(): void;
	/** 採点に失敗したニュースを採点し直す対象へ戻す。失敗していなければ false */
	retry(newsId: number): boolean;
	/** 最新のニュースを、渡した採点の基準で採点する。保存も集計への反映もしない */
	trial(criteria: string): Promise<TrialResult>;
}
