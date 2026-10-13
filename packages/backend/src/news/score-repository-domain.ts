import type { AggregationRule, ScoredNews } from "@trading-studio/core";
import type { ScoreResponse } from "./prompt-domain";
import type {
	CriteriaVersion,
	NewsScore,
	RescoreCoverage,
} from "./types-domain";

export interface ScoreRepository {
	/** 版が1つも無ければ初版を入れて使用中にする */
	seedCriteria(text: string, now: number): void;
	listCriteria(): CriteriaVersion[];
	getCriteria(version: number): CriteriaVersion | null;
	addCriteria(text: string, note: string, now: number): CriteriaVersion;
	activeCriteriaVersion(): number | null;
	setActiveCriteria(version: number): void;
	model(fallback: string): string;
	setModel(model: string): void;
	apiKey(): string | null;
	apiKeySavedAt(): number | null;
	setApiKey(key: string, now: number): void;
	deleteApiKey(): void;
	/** 集計ルール。保存されていないか壊れていれば既定値 */
	aggregationRule(): AggregationRule;
	setAggregationRule(rule: AggregationRule): void;
	/** 採点していないニュースの件数（再試行待ちを含む） */
	pendingCount(): number;
	/** 採点していないニュースのうち、新しさの時刻が before より前のものを「採点しない」にする */
	skipOlderThan(before: number): void;
	/** 次に採点するニュース。未採点と、再試行の時刻が来たものを、取得した順に */
	nextToScore(now: number): NextToScore | null;
	saveScore(
		newsId: number,
		r: ScoreResponse,
		meta: {
			scoredAt: number;
			criteriaVersion: number;
			model: string;
			/** 採点したアプリのバージョン（ビルド日時）。開発版は null */
			appBuiltAt: number | null;
			attempts: number;
		},
	): void;
	/** 失敗を記録する。nextAttemptAt が null なら「採点に失敗」で止める */
	saveFailure(
		newsId: number,
		error: string,
		attempts: number,
		nextAttemptAt: number | null,
	): void;
	/** 採点に失敗したニュースを、すぐに採点し直す対象へ戻す。失敗していなければ false */
	requestRetry(newsId: number, now: number): boolean;
	/** 失敗したものと再試行を待っているものを、すぐ採点し直す対象へ戻す */
	retryAllFailed(now: number): void;
	getScore(newsId: number): NewsScore | null;
	/**
	 * 判定に使い始める時刻が [from, to) の採点済みのニュース（集計の入力）。
	 * 使い始める時刻は、delayMs が null なら運用の採点時刻（運用の判定）、数なら新しさの時刻に delayMs を足した時刻
	 * （バックテスト。取得の間隔ぶん遅れて知る前提。docs/news.md）。
	 * version を渡すと、点数をその版の採点（運用の採点がその版ならそれ、無ければ採点し直した結果）にする。その版の採点が無い記事は除く
	 */
	scoredNews(
		from: number,
		to: number,
		version?: number | null,
		delayMs?: number | null,
	): ScoredNews[];
	/**
	 * scoredNews と同じ記事の、データの最終更新時刻（取得・採点・採点し直し・置き換えのうち最新）。記事が無ければ null。
	 * バックテストの結果に、使ったニュースのデータの版として残す
	 */
	newsDataVersion(
		from: number,
		to: number,
		version: number | null,
		delayMs: number,
	): number | null;
	/**
	 * バックテストで使い始める時刻（scoredNews の delayMs）が [from, to) の採点済みのニュースについて、指定した版の採点が揃っているか。
	 * 運用で採点されなかった記事（古くて採点しない・失敗）は使わないので数えない
	 */
	rescoreCoverage(
		from: number,
		to: number,
		version: number,
		delayMs: number,
	): RescoreCoverage;
	/**
	 * rescoreCoverage と同じ記事のうち、指定した版の採点が無いものを採点し直す対象に入れる。
	 * 失敗したものも入れ直す。入れた件数を返す
	 */
	queueRescore(
		from: number,
		to: number,
		version: number,
		delayMs: number,
		now: number,
	): number;
	/** 次に採点し直すニュース。頼んだ順、同じ頼みの中は取得した順 */
	nextToRescore(now: number): NextToRescore | null;
	saveRescore(
		newsId: number,
		version: number,
		r: ScoreResponse,
		meta: {
			scoredAt: number;
			model: string;
			appBuiltAt: number | null;
			attempts: number;
		},
	): void;
	/**
	 * 運用の採点を指定した版の採点で置き換えるよう頼む（ニュース画面から）。運用で採点済みで、別の版で採点したものだけ。
	 * その版の採点が既にあればすぐ置き換える。頼んだか置き換えた件数を返す
	 */
	requestReplace(
		newsIds: readonly number[],
		version: number,
		now: number,
	): number;
	/** 運用の採点を置き換える採点し直しを待っている件数（再試行待ちを含む） */
	liveRescorePending(): number;
	/** 採点し直しの失敗を記録する。nextAttemptAt が null なら「失敗」で止める */
	saveRescoreFailure(
		newsId: number,
		version: number,
		error: string,
		attempts: number,
		nextAttemptAt: number | null,
	): void;
	/** 古いニュースを消した境目。消したことが無ければ null（retention/repository が書く） */
	newsDeletedBefore(): number | null;
	/** 最初に採点した時刻。古いニュースを消した後の記録の始まりは judgmentRecordStart で求める */
	firstScoredAt(): number | null;
}

export type NextToScore = {
	id: number;
	sourceName: string;
	title: string;
	summary: string | null;
	publishedAt: number;
	fetchedAt: number;
	attempts: number;
};

export type NextToRescore = NextToScore & { criteriaVersion: number };
