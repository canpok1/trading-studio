import type { AggregationRule, ScoredNews } from "@trading-studio/core";
import {
	DEFAULT_AGGREGATION_RULE,
	parseAggregationRule,
	validateAggregationRule,
} from "@trading-studio/core";
import type { Db } from "../db/open";
import type { ScoreResponse } from "./prompt";
import type { CriteriaVersion, NewsScore } from "./types";

type ScoreRow = {
	news_id: number;
	status: NewsScore["status"];
	trend: number | null;
	risk: number | null;
	sentiment: number | null;
	comment: string | null;
	scored_at: number | null;
	criteria_version: number | null;
	model: string | null;
	error: string | null;
	attempts: number;
	next_attempt_at: number | null;
};

export const toNewsScore = (r: ScoreRow): NewsScore => ({
	status: r.status,
	scores:
		r.status === "done"
			? { trend: r.trend, risk: r.risk, sentiment: r.sentiment }
			: null,
	comment: r.comment,
	scoredAt: r.scored_at,
	criteriaVersion: r.criteria_version,
	model: r.model,
	error: r.error,
	nextAttemptAt: r.next_attempt_at,
});

type CriteriaRow = {
	version: number;
	text: string;
	note: string;
	created_at: number;
};

const toCriteria = (r: CriteriaRow): CriteriaVersion => ({
	version: r.version,
	text: r.text,
	note: r.note,
	createdAt: r.created_at,
});

const ACTIVE_CRITERIA_KEY = "scoring_criteria_active";
const MODEL_KEY = "scoring_model";
const RULE_KEY = "aggregation_rule";
const API_KEY_KEY = "gemini_api_key";
const API_KEY_SAVED_AT_KEY = "gemini_api_key_saved_at";

export type NextToScore = {
	id: number;
	sourceName: string;
	title: string;
	summary: string | null;
	publishedAt: number;
	fetchedAt: number;
	attempts: number;
};

export class ScoreRepository {
	constructor(private readonly db: Db) {}

	private get sql() {
		return this.db.$client;
	}

	private setting(key: string): string | null {
		return (
			this.sql
				.query<{ value: string }, [string]>(
					"select value from settings where key = ?",
				)
				.get(key)?.value ?? null
		);
	}

	private setSetting(key: string, value: string) {
		this.sql.run(
			"insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
			[key, value],
		);
	}

	/** 版が1つも無ければ初版を入れて使用中にする */
	seedCriteria(text: string, now: number) {
		this.sql.transaction(() => {
			if (this.listCriteria().length > 0) return;
			const v = this.addCriteria(text, "初版", now);
			this.setActiveCriteria(v.version);
		})();
	}

	listCriteria(): CriteriaVersion[] {
		return this.sql
			.query<CriteriaRow, []>("select * from scoring_criteria order by version")
			.all()
			.map(toCriteria);
	}

	getCriteria(version: number): CriteriaVersion | null {
		const r = this.sql
			.query<CriteriaRow, [number]>(
				"select * from scoring_criteria where version = ?",
			)
			.get(version);
		return r ? toCriteria(r) : null;
	}

	addCriteria(text: string, note: string, now: number): CriteriaVersion {
		return toCriteria(
			this.sql
				.query<CriteriaRow, [string, string, number]>(
					"insert into scoring_criteria (text, note, created_at) values (?, ?, ?) returning *",
				)
				.get(text, note, now) as CriteriaRow,
		);
	}

	activeCriteriaVersion(): number | null {
		const v = this.setting(ACTIVE_CRITERIA_KEY);
		return v === null ? null : Number(v);
	}

	setActiveCriteria(version: number) {
		this.setSetting(ACTIVE_CRITERIA_KEY, String(version));
	}

	model(fallback: string): string {
		return this.setting(MODEL_KEY) ?? fallback;
	}

	setModel(model: string) {
		this.setSetting(MODEL_KEY, model);
	}

	apiKey(): string | null {
		return this.setting(API_KEY_KEY);
	}

	apiKeySavedAt(): number | null {
		const v = this.setting(API_KEY_SAVED_AT_KEY);
		return v === null ? null : Number(v);
	}

	setApiKey(key: string, now: number) {
		this.sql.transaction(() => {
			this.setSetting(API_KEY_KEY, key);
			this.setSetting(API_KEY_SAVED_AT_KEY, String(now));
		})();
	}

	deleteApiKey() {
		this.sql.run("delete from settings where key in (?, ?)", [
			API_KEY_KEY,
			API_KEY_SAVED_AT_KEY,
		]);
	}

	/** 集計ルール。保存されていないか壊れていれば既定値 */
	aggregationRule(): AggregationRule {
		const v = this.setting(RULE_KEY);
		if (v === null) return DEFAULT_AGGREGATION_RULE;
		let r: AggregationRule | null;
		try {
			r = parseAggregationRule(JSON.parse(v));
		} catch {
			r = null;
		}
		return r && validateAggregationRule(r).length === 0
			? r
			: DEFAULT_AGGREGATION_RULE;
	}

	setAggregationRule(rule: AggregationRule) {
		this.setSetting(RULE_KEY, JSON.stringify(rule));
	}

	/** 採点していないニュースの件数（再試行待ちを含む） */
	pendingCount(): number {
		return (
			this.sql
				.query<{ c: number }, []>(
					`select count(*) as c from news n left join news_scores s on s.news_id = n.id
					 where s.news_id is null or s.status = 'retry'`,
				)
				.get()?.c ?? 0
		);
	}

	/** 採点していないニュースのうち、新しさの時刻が before より前のものを「採点しない」にする */
	skipOlderThan(before: number) {
		this.sql.run(
			`insert into news_scores (news_id, status)
			 select n.id, 'skipped' from news n
			 left join news_scores s on s.news_id = n.id
			 where s.news_id is null and min(n.published_at, n.fetched_at) < ?`,
			[before],
		);
	}

	/** 次に採点するニュース。未採点と、再試行の時刻が来たものを、取得した順に */
	nextToScore(now: number): NextToScore | null {
		return (
			this.sql
				.query<NextToScore, [number]>(
					`select n.id, n.source_name as sourceName, n.title, n.summary,
					   n.published_at as publishedAt, n.fetched_at as fetchedAt,
					   coalesce(s.attempts, 0) as attempts
					 from news n left join news_scores s on s.news_id = n.id
					 where s.news_id is null or (s.status = 'retry' and s.next_attempt_at <= ?)
					 order by n.fetched_at, n.id limit 1`,
				)
				.get(now) ?? null
		);
	}

	saveScore(
		newsId: number,
		r: ScoreResponse,
		meta: {
			scoredAt: number;
			criteriaVersion: number;
			model: string;
			attempts: number;
		},
	) {
		this.sql.run(
			`insert into news_scores (news_id, status, trend, risk, sentiment, comment, scored_at, criteria_version, model, error, attempts, next_attempt_at)
			 values (?, 'done', ?, ?, ?, ?, ?, ?, ?, null, ?, null)
			 on conflict (news_id) do update set status = 'done', trend = excluded.trend, risk = excluded.risk,
			   sentiment = excluded.sentiment, comment = excluded.comment, scored_at = excluded.scored_at,
			   criteria_version = excluded.criteria_version, model = excluded.model, error = null,
			   attempts = excluded.attempts, next_attempt_at = null`,
			[
				newsId,
				r.scores.trend,
				r.scores.risk,
				r.scores.sentiment,
				r.comment,
				meta.scoredAt,
				meta.criteriaVersion,
				meta.model,
				meta.attempts,
			],
		);
	}

	/** 失敗を記録する。nextAttemptAt が null なら「採点に失敗」で止める */
	saveFailure(
		newsId: number,
		error: string,
		attempts: number,
		nextAttemptAt: number | null,
	) {
		const status = nextAttemptAt === null ? "failed" : "retry";
		this.sql.run(
			`insert into news_scores (news_id, status, error, attempts, next_attempt_at) values (?, ?, ?, ?, ?)
			 on conflict (news_id) do update set status = excluded.status, error = excluded.error,
			   attempts = excluded.attempts, next_attempt_at = excluded.next_attempt_at`,
			[newsId, status, error, attempts, nextAttemptAt],
		);
	}

	/** 採点に失敗したニュースを、すぐに採点し直す対象へ戻す。失敗していなければ false */
	requestRetry(newsId: number, now: number): boolean {
		return (
			this.sql.run(
				"update news_scores set status = 'retry', attempts = 0, next_attempt_at = ? where news_id = ? and status = 'failed'",
				[now, newsId],
			).changes > 0
		);
	}

	/** 失敗したものと再試行を待っているものを、すぐ採点し直す対象へ戻す */
	retryAllFailed(now: number) {
		this.sql.run(
			"update news_scores set status = 'retry', attempts = 0, next_attempt_at = ? where status in ('failed', 'retry')",
			[now],
		);
	}

	getScore(newsId: number): NewsScore | null {
		const r = this.sql
			.query<ScoreRow, [number]>("select * from news_scores where news_id = ?")
			.get(newsId);
		return r ? toNewsScore(r) : null;
	}

	/** 採点時刻が [from, to) の採点済みのニュース（集計の入力） */
	scoredNews(from: number, to: number): ScoredNews[] {
		return this.sql
			.query<
				{
					id: number;
					published_at: number;
					fetched_at: number;
					scored_at: number;
					trend: number | null;
					risk: number | null;
					sentiment: number | null;
				},
				[number, number]
			>(
				`select n.id, n.published_at, n.fetched_at, s.scored_at, s.trend, s.risk, s.sentiment
				 from news_scores s join news n on n.id = s.news_id
				 where s.status = 'done' and s.scored_at >= ? and s.scored_at < ?
				 order by s.scored_at, n.id`,
			)
			.all(from, to)
			.map((r) => ({
				id: r.id,
				publishedAt: r.published_at,
				fetchedAt: r.fetched_at,
				scoredAt: r.scored_at,
				scores: { trend: r.trend, risk: r.risk, sentiment: r.sentiment },
			}));
	}

	/** 最初に採点した時刻。採点の記録の始まり */
	firstScoredAt(): number | null {
		return (
			this.sql
				.query<{ t: number | null }, []>(
					"select min(scored_at) as t from news_scores where status = 'done'",
				)
				.get()?.t ?? null
		);
	}
}
