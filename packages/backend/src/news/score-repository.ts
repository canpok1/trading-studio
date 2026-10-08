import type {
	AggregationRule,
	Duration,
	ScoredNews,
} from "@trading-studio/core";
import {
	DEFAULT_AGGREGATION_RULE,
	parseAggregationRule,
	validateAggregationRule,
} from "@trading-studio/core";
import type { Db } from "../db/open";
import type { ScoreResponse } from "./prompt";
import type { CriteriaVersion, NewsScore, RescoreCoverage } from "./types";

type ScoreRow = {
	news_id: number;
	status: NewsScore["status"];
	risk: number | null;
	sentiment: number | null;
	duration: Duration | null;
	comment: string | null;
	scored_at: number | null;
	rescored_at: number | null;
	criteria_version: number | null;
	model: string | null;
	app_built_at: number | null;
	error: string | null;
	attempts: number;
	next_attempt_at: number | null;
};

export const toNewsScore = (r: ScoreRow): NewsScore => ({
	status: r.status,
	scores:
		r.status === "done"
			? { sentiment: r.sentiment ?? 0, risk: r.risk ?? 0 }
			: null,
	duration: r.status === "done" ? (r.duration ?? "short") : null,
	comment: r.comment,
	scoredAt: r.scored_at,
	rescoredAt: r.rescored_at,
	criteriaVersion: r.criteria_version,
	model: r.model,
	appBuiltAt: r.app_built_at,
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

/** 古いニュースを消した境目を持つ settings のキー */
export const NEWS_DELETED_BEFORE_KEY = "news_deleted_before";

/** 新しさの時刻（公開時刻と取得時刻の早い方。core の newsTime と同じ）の SQL の式 */
export const NEWS_TIME_SQL = "min(n.published_at, n.fetched_at)";

/**
 * 判定に使い始める時刻の SQL の式（expr）と、それが [from, to) に入る条件（where）。
 * delayMs が null なら採点時刻、数なら新しさの時刻 + delayMs（scoredNews）
 */
function usableAt(
	delayMs: number | null,
	from: number,
	to: number,
): {
	expr: string;
	exprParams: number[];
	where: string;
	whereParams: number[];
} {
	if (delayMs === null)
		return {
			expr: "s.scored_at",
			exprParams: [],
			where: "s.scored_at >= ? and s.scored_at < ?",
			whereParams: [from, to],
		};
	// 公開時刻は新しさの時刻以上なので、下限は公開時刻のインデックスでも絞れる
	return {
		expr: `(${NEWS_TIME_SQL} + ?)`,
		exprParams: [delayMs],
		where: `n.published_at >= ? and ${NEWS_TIME_SQL} >= ? and ${NEWS_TIME_SQL} < ?`,
		whereParams: [from - delayMs, from - delayMs, to - delayMs],
	};
}

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

export type NextToRescore = NextToScore & { criteriaVersion: number };

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
			/** 採点したアプリのバージョン（ビルド日時）。開発版は null */
			appBuiltAt: number | null;
			attempts: number;
		},
	) {
		this.sql.run(
			`insert into news_scores (news_id, status, sentiment, risk, duration, comment, scored_at, criteria_version, model, app_built_at, error, attempts, next_attempt_at)
			 values (?, 'done', ?, ?, ?, ?, ?, ?, ?, ?, null, ?, null)
			 on conflict (news_id) do update set status = 'done', sentiment = excluded.sentiment, risk = excluded.risk, duration = excluded.duration,
			   comment = excluded.comment, scored_at = excluded.scored_at,
			   criteria_version = excluded.criteria_version, model = excluded.model,
			   app_built_at = excluded.app_built_at, error = null,
			   attempts = excluded.attempts, next_attempt_at = null`,
			[
				newsId,
				r.scores.sentiment,
				r.scores.risk,
				r.duration,
				r.comment,
				meta.scoredAt,
				meta.criteriaVersion,
				meta.model,
				meta.appBuiltAt,
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
		this.sql.transaction(() => {
			for (const table of ["news_scores", "news_rescores"])
				this.sql.run(
					`update ${table} set status = 'retry', attempts = 0, next_attempt_at = ? where status in ('failed', 'retry')`,
					[now],
				);
		})();
	}

	getScore(newsId: number): NewsScore | null {
		const r = this.sql
			.query<ScoreRow, [number]>("select * from news_scores where news_id = ?")
			.get(newsId);
		return r ? toNewsScore(r) : null;
	}

	/**
	 * 判定に使い始める時刻が [from, to) の採点済みのニュース（集計の入力）。
	 * 使い始める時刻は、delayMs が null なら運用の採点時刻（運用の判定）、数なら新しさの時刻に delayMs を足した時刻
	 * （バックテスト。取得の間隔ぶん遅れて知る前提。docs/news.md）。
	 * version を渡すと、点数をその版の採点（運用の採点がその版ならそれ、無ければ採点し直した結果）にする。その版の採点が無い記事は除く
	 */
	scoredNews(
		from: number,
		to: number,
		version: number | null = null,
		delayMs: number | null = null,
	): ScoredNews[] {
		type Row = {
			id: number;
			published_at: number;
			fetched_at: number;
			usable_at: number;
			sentiment: number;
			risk: number;
			duration: Duration;
		};
		const u = usableAt(delayMs, from, to);
		const rows =
			version === null
				? this.sql
						.query<Row, number[]>(
							`select n.id, n.published_at, n.fetched_at, ${u.expr} as usable_at, s.sentiment, s.risk, s.duration
							 from news_scores s join news n on n.id = s.news_id
							 where s.status = 'done' and ${u.where}
							 order by usable_at, n.id`,
						)
						.all(...u.exprParams, ...u.whereParams)
				: this.sql
						.query<Row, number[]>(
							`select n.id, n.published_at, n.fetched_at, ${u.expr} as usable_at,
							   case when s.criteria_version = ? then s.sentiment else r.sentiment end as sentiment,
							   case when s.criteria_version = ? then s.risk else r.risk end as risk,
							   case when s.criteria_version = ? then s.duration else r.duration end as duration
							 from news_scores s join news n on n.id = s.news_id
							 left join news_rescores r on r.news_id = s.news_id and r.criteria_version = ? and r.status = 'done'
							 where s.status = 'done' and ${u.where}
							   and (s.criteria_version = ? or r.news_id is not null)
							 order by usable_at, n.id`,
						)
						.all(
							...u.exprParams,
							version,
							version,
							version,
							version,
							...u.whereParams,
							version,
						);
		return rows.map((r) => ({
			id: r.id,
			publishedAt: r.published_at,
			fetchedAt: r.fetched_at,
			usableAt: r.usable_at,
			scores: { sentiment: r.sentiment, risk: r.risk },
			duration: r.duration,
		}));
	}

	/**
	 * scoredNews と同じ記事の、データの最終更新時刻（取得・採点・採点し直し・置き換えのうち最新）。記事が無ければ null。
	 * バックテストの結果に、使ったニュースのデータの版として残す
	 */
	newsDataVersion(
		from: number,
		to: number,
		version: number | null,
		delayMs: number,
	): number | null {
		const u = usableAt(delayMs, from, to);
		return (
			this.sql
				.query<{ t: number | null }, (number | null)[]>(
					`select max(max(n.fetched_at, s.scored_at, coalesce(s.rescored_at, 0), coalesce(r.scored_at, 0))) as t
					 from news_scores s join news n on n.id = s.news_id
					 left join news_rescores r on r.news_id = s.news_id and r.criteria_version = ? and r.status = 'done'
					 where s.status = 'done' and ${u.where}
					   and (? is null or s.criteria_version = ? or r.news_id is not null)`,
				)
				.get(version ?? -1, ...u.whereParams, version, version ?? -1)?.t ?? null
		);
	}

	/**
	 * バックテストで使い始める時刻（scoredNews の delayMs）が [from, to) の採点済みのニュースについて、指定した版の採点が揃っているか。
	 * 運用で採点されなかった記事（古くて採点しない・失敗）は使わないので数えない
	 */
	rescoreCoverage(
		from: number,
		to: number,
		version: number,
		delayMs: number,
	): RescoreCoverage {
		const u = usableAt(delayMs, from, to);
		return this.sql
			.query<RescoreCoverage, number[]>(
				`select count(*) as total,
				   coalesce(sum(case when s.criteria_version = ? or r.status = 'done' then 1 else 0 end), 0) as done,
				   coalesce(sum(case when r.status in ('queued', 'retry') then 1 else 0 end), 0) as pending,
				   coalesce(sum(case when r.status = 'failed' then 1 else 0 end), 0) as failed
				 from news_scores s join news n on n.id = s.news_id
				 left join news_rescores r on r.news_id = s.news_id and r.criteria_version = ?
				 where s.status = 'done' and ${u.where}`,
			)
			.get(version, version, ...u.whereParams) as RescoreCoverage;
	}

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
	): number {
		const u = usableAt(delayMs, from, to);
		return this.sql.run(
			`insert into news_rescores (news_id, criteria_version, status, attempts, requested_at)
			 select s.news_id, ?, 'queued', 0, ? from news_scores s join news n on n.id = s.news_id
			 where s.status = 'done' and ${u.where}
			   and (s.criteria_version is null or s.criteria_version != ?)
			 on conflict (news_id, criteria_version) do update set status = 'queued', attempts = 0,
			   next_attempt_at = null, error = null, requested_at = excluded.requested_at
			 where news_rescores.status = 'failed'`,
			[version, now, ...u.whereParams, version],
		).changes;
	}

	/** 次に採点し直すニュース。頼んだ順、同じ頼みの中は取得した順 */
	nextToRescore(now: number): NextToRescore | null {
		return (
			this.sql
				.query<NextToRescore, [number]>(
					`select n.id, n.source_name as sourceName, n.title, n.summary,
					   n.published_at as publishedAt, n.fetched_at as fetchedAt,
					   r.attempts, r.criteria_version as criteriaVersion
					 from news_rescores r join news n on n.id = r.news_id
					 where r.status = 'queued' or (r.status = 'retry' and r.next_attempt_at <= ?)
					 order by r.requested_at, n.fetched_at, n.id limit 1`,
				)
				.get(now) ?? null
		);
	}

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
	) {
		this.sql.transaction(() => {
			this.sql.run(
				`update news_rescores set status = 'done', sentiment = ?, risk = ?, duration = ?, comment = ?, scored_at = ?,
				   model = ?, app_built_at = ?, error = null, attempts = ?, next_attempt_at = null
				 where news_id = ? and criteria_version = ?`,
				[
					r.scores.sentiment,
					r.scores.risk,
					r.duration,
					r.comment,
					meta.scoredAt,
					meta.model,
					meta.appBuiltAt,
					meta.attempts,
					newsId,
					version,
				],
			);
			const at = this.sql
				.query<{ replace_requested_at: number | null }, [number, number]>(
					"select replace_requested_at from news_rescores where news_id = ? and criteria_version = ?",
				)
				.get(newsId, version)?.replace_requested_at;
			if (at != null) this.replaceLive(newsId, version, at);
		})();
	}

	/**
	 * 運用の採点を指定した版の採点で置き換えるよう頼む（ニュース画面から）。運用で採点済みで、別の版で採点したものだけ。
	 * その版の採点が既にあればすぐ置き換える。頼んだか置き換えた件数を返す
	 */
	requestReplace(
		newsIds: readonly number[],
		version: number,
		now: number,
	): number {
		let n = 0;
		this.sql.transaction(() => {
			for (const id of newsIds) {
				const s = this.sql
					.query<{ status: string; criteria_version: number | null }, [number]>(
						"select status, criteria_version from news_scores where news_id = ?",
					)
					.get(id);
				if (s?.status !== "done") continue;
				if (s.criteria_version === version) {
					// 今の採点のままにするのが最後の頼みなので、前に頼んだ別の版の置き換えは取り下げる
					this.dropReplaceRequests(id, now);
					continue;
				}
				const r = this.sql
					.query<{ status: string }, [number, number]>(
						"select status from news_rescores where news_id = ? and criteria_version = ?",
					)
					.get(id, version);
				if (r?.status === "done") {
					this.replaceLive(id, version, now);
				} else if (r) {
					// 待っているものは順番を変えずに頼んだ時刻だけ付ける。失敗して止まっているものは頼み直す
					this.sql.run(
						`update news_rescores set replace_requested_at = ?,
						   status = case when status = 'failed' then 'queued' else status end,
						   attempts = case when status = 'failed' then 0 else attempts end,
						   next_attempt_at = case when status = 'failed' then null else next_attempt_at end,
						   error = case when status = 'failed' then null else error end,
						   requested_at = case when status = 'failed' then ? else requested_at end
						 where news_id = ? and criteria_version = ?`,
						[now, now, id, version],
					);
				} else {
					this.sql.run(
						`insert into news_rescores (news_id, criteria_version, status, attempts, requested_at, replace_requested_at)
						 values (?, ?, 'queued', 0, ?, ?)`,
						[id, version, now, now],
					);
				}
				n++;
			}
		})();
		return n;
	}

	/**
	 * 運用の採点を、採点し直したその版の採点で置き換える。判定に使い始める時刻（scored_at）は変えない。
	 * 元の採点は、版ごとのバックテストで使えるようにその版の行として残す（版の記録が無い採点は残せない）。
	 * requestedAt より後に別の版の置き換えを頼んでいれば、最後の頼みを優先して置き換えない
	 */
	private replaceLive(newsId: number, version: number, requestedAt: number) {
		const newer = this.sql
			.query<{ c: number }, [number, number, number]>(
				`select count(*) as c from news_rescores
				 where news_id = ? and criteria_version != ? and replace_requested_at > ?`,
			)
			.get(newsId, version, requestedAt)?.c;
		if (newer) {
			this.sql.run(
				"update news_rescores set replace_requested_at = null where news_id = ? and criteria_version = ?",
				[newsId, version],
			);
			return;
		}
		const r = this.sql
			.query<ScoreRow, [number, number]>(
				"select * from news_rescores where news_id = ? and criteria_version = ? and status = 'done'",
			)
			.get(newsId, version);
		const s = this.sql
			.query<ScoreRow, [number]>("select * from news_scores where news_id = ?")
			.get(newsId);
		if (r && s?.status === "done" && s.criteria_version !== version) {
			if (s.criteria_version !== null) {
				const at = s.rescored_at ?? s.scored_at ?? 0;
				this.sql.run(
					`insert into news_rescores (news_id, criteria_version, status, sentiment, risk, duration, comment, scored_at, model, app_built_at, attempts, requested_at)
					 values (?, ?, 'done', ?, ?, ?, ?, ?, ?, ?, 0, ?)
					 on conflict (news_id, criteria_version) do update set status = 'done', sentiment = excluded.sentiment,
					   risk = excluded.risk, duration = excluded.duration, comment = excluded.comment, scored_at = excluded.scored_at, model = excluded.model,
					   app_built_at = excluded.app_built_at, error = null, next_attempt_at = null
					 where news_rescores.status != 'done'`,
					[
						newsId,
						s.criteria_version,
						s.sentiment,
						s.risk,
						s.duration,
						s.comment,
						at,
						s.model,
						s.app_built_at,
						at,
					],
				);
			}
			this.sql.run(
				`update news_scores set sentiment = ?, risk = ?, duration = ?, comment = ?, criteria_version = ?, model = ?,
				   app_built_at = ?, rescored_at = ? where news_id = ?`,
				[
					r.sentiment,
					r.risk,
					r.duration,
					r.comment,
					version,
					r.model,
					r.app_built_at,
					r.scored_at,
					newsId,
				],
			);
		}
		this.dropReplaceRequests(newsId, requestedAt);
	}

	/** at までに頼んだ置き換えを取り下げる。後から古い版で置き換えたり、古い失敗を出し続けたりしないため */
	private dropReplaceRequests(newsId: number, at: number) {
		this.sql.run(
			"update news_rescores set replace_requested_at = null where news_id = ? and replace_requested_at <= ?",
			[newsId, at],
		);
	}

	/** 運用の採点を置き換える採点し直しを待っている件数（再試行待ちを含む） */
	liveRescorePending(): number {
		return (
			this.sql
				.query<{ c: number }, []>(
					"select count(*) as c from news_rescores where replace_requested_at is not null and status in ('queued', 'retry')",
				)
				.get()?.c ?? 0
		);
	}

	/** 採点し直しの失敗を記録する。nextAttemptAt が null なら「失敗」で止める */
	saveRescoreFailure(
		newsId: number,
		version: number,
		error: string,
		attempts: number,
		nextAttemptAt: number | null,
	) {
		this.sql.run(
			`update news_rescores set status = ?, error = ?, attempts = ?, next_attempt_at = ?
			 where news_id = ? and criteria_version = ?`,
			[
				nextAttemptAt === null ? "failed" : "retry",
				error,
				attempts,
				nextAttemptAt,
				newsId,
				version,
			],
		);
	}

	/** 古いニュースを消した境目。消したことが無ければ null（retention/repository が書く） */
	newsDeletedBefore(): number | null {
		const r = this.sql
			.query<{ value: string }, [string]>(
				"select value from settings where key = ?",
			)
			.get(NEWS_DELETED_BEFORE_KEY);
		return r ? (JSON.parse(r.value) as number) : null;
	}

	/** 最初に採点した時刻。古いニュースを消した後の記録の始まりは judgmentRecordStart で求める */
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
