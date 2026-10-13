// ニュース収集と採点の型。app.ts から参照されるため、Bun 固有の型を持ち込まない

import type { Duration, Scores } from "@trading-studio/core";

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
	/** 運用の採点を置き換える採点し直し（ニュース画面から頼んだもの）のうち、終わっていないもの。無ければ null */
	rescore: LiveRescore | null;
};

export type LiveRescore = {
	/** 採点し直す版 */
	version: number;
	/** running: 採点し直している / waiting: 順番を待っている / retry: 失敗して再試行の時刻を待っている / failed: 失敗して止まっている */
	status: "running" | "waiting" | "retry" | "failed";
	/** waiting のとき、先に採点し直す件数（採点し直している1件と、バックテスト用に頼んだ分を含む）。それ以外は null */
	ahead: number | null;
	/** retry のとき、次に再試行する時刻。それ以外は null */
	nextAttemptAt: number | null;
	error: string | null;
};

export type NewsScore = {
	/** done: 採点済み / retry: 再試行を待っている / failed: 採点に失敗 / skipped: 古いので採点しない */
	status: "done" | "retry" | "failed" | "skipped";
	/** 観点ごとの点数。採点済みでなければ null */
	scores: Scores | null;
	/** 影響の持続。採点済みでなければ null */
	duration: Duration | null;
	comment: string | null;
	/** 判定に使い始める時刻。採点し直して置き換えても変えない */
	scoredAt: number | null;
	/** 採点し直して点数を置き換えた時刻。置き換えていなければ null。版・モデル・アプリのバージョンは置き換えた採点のもの */
	rescoredAt: number | null;
	criteriaVersion: number | null;
	model: string | null;
	/** 採点したアプリのバージョン（ビルド日時）。開発版と記録前の採点は null */
	appBuiltAt: number | null;
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
	/** 運用の採点を置き換える採点し直しを待っている件数（再試行待ちを含む） */
	rescorePending: number;
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
	/** 条件で絞ったニュース。影響の大きさは今の評価基準で測る */
	searchNews(filter: NewsFilter): NewsSearchResult;
}

/** 一覧で一度に読める件数の上限 */
export const NEWS_LIST_MAX = 1000;

/** bull: 強気材料（やや強気以上）、bear: 弱気材料（やや弱気以下）、risk: リスク高（警戒以上） */
export const NEWS_IMPACTS = ["bull", "bear", "risk"] as const;
export type NewsImpact = (typeof NEWS_IMPACTS)[number];

/** new: 新しい順、impact: 影響の大きい順（センチメントの絶対値とリスクの大きい方） */
export const NEWS_SORTS = ["new", "impact"] as const;
export type NewsSort = (typeof NEWS_SORTS)[number];

export type NewsFilter = {
	/** 公開時刻が [from, to) のもの */
	from: number | null;
	to: number | null;
	/** 空白で区切った語をすべて含む（見出し・概要・採点の理由のどれかに） */
	q: string;
	/** どれかに当てはまるもの。空なら絞らない */
	impacts: NewsImpact[];
	/** 持続がどれかのもの（採点済みだけ）。空なら絞らない */
	durations: Duration[];
	/** この時刻の市場評価に使っている（重みが 0% より大きい）ものだけ。null なら絞らない */
	activeAt: number | null;
	sort: NewsSort;
	limit: number;
};

export type NewsSearchResult = {
	news: NewsItem[];
	/** 条件に当てはまる件数（limit を超えた分も数える） */
	total: number;
};

export type ScoringModelOption = { id: string; label: string };

/** 試し採点で一度に採点できる記事の数 */
export const TRIAL_MAX_NEWS = 5;

export type TrialItem = {
	news: {
		id: number;
		title: string;
		sourceName: string;
		publishedAt: number;
		/** 保存済みの採点。採点済みでなければ null */
		stored: {
			scores: Scores;
			duration: Duration;
			comment: string | null;
			criteriaVersion: number | null;
		} | null;
	};
	result:
		| { ok: true; scores: Scores; duration: Duration; comment: string }
		| { ok: false; message: string };
};

export type TrialResult =
	| { ok: true; items: TrialItem[] }
	| { ok: false; message: string };

/**
 * バックテストの期間の市場評価に使う記事について、指定した版の採点が揃っているか。
 * done + pending + failed + まだ頼んでいない数 = total
 */
export type RescoreCoverage = {
	/** 運用で採点済みの記事の数。運用で採点されなかった記事は運用でも使われないので数えない */
	total: number;
	/** その版の採点がある */
	done: number;
	/** 採点し直しを待っている（再試行待ちを含む） */
	pending: number;
	/** 採点し直しに失敗して止まっている */
	failed: number;
};

export type RescoreResult =
	| { ok: true; coverage: RescoreCoverage }
	| { ok: false; status: 400 | 404; message: string };

export type LiveRescoreResult =
	| {
			ok: true;
			/** 採点し直す版（使用中の版） */
			version: number;
			/** 採点し直しを頼んだか、その版の採点が既にあって置き換えたか。使用中の版で採点済みか、運用で採点済みでなければ false */
			requested: boolean;
	  }
	| { ok: false; status: 409; message: string };

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
	/** バックテストの期間 [from, to) の市場評価に使う記事に、指定した版の採点が揃っているか */
	rescoreCoverage(from: number, to: number, version: number): RescoreResult;
	/** バックテストの期間 [from, to) の市場評価に使う記事のうち、指定した版の採点が無いもの（失敗を含む）を採点し直す対象に入れる */
	requestRescore(from: number, to: number, version: number): RescoreResult;
	/**
	 * ニュースを1件、使用中の版で採点し直し、運用の採点を置き換えるよう頼む（ニュース画面から）。
	 * 判定に使い始める時刻は変えない
	 */
	rescoreLive(newsId: number): LiveRescoreResult;
	/** 指定したニュース（省けば最新の1件）を、渡した採点の基準で採点する。保存も集計への反映もしない */
	trial(criteria: string, newsIds?: readonly number[]): Promise<TrialResult>;
}
