import type { AggregationRule } from "@trading-studio/core";
import { LASTING_DURATIONS, windowMs } from "@trading-studio/core";
import type { Db } from "../db/open";
import type { FeedItem } from "./rss";
import { toNewsScore } from "./score-repository";
import type {
	LiveRescore,
	NewsFilter,
	NewsItem,
	NewsLanguage,
	NewsSearchResult,
	NewsSource,
	NewsSourceInput,
} from "./types";

type SourceRow = {
	id: number;
	name: string;
	url: string;
	language: NewsLanguage;
	enabled: number;
	created_at: number;
	last_success_at: number | null;
	last_error: string | null;
	error_since: number | null;
};

type ScoreRow = Parameters<typeof toNewsScore>[0];

/** news と news_scores を left join した行。採点の行が無ければ採点の列は null */
type NewsRow = Omit<ScoreRow, "status"> & {
	id: number;
	source_id: number;
	source_name: string;
	language: NewsLanguage;
	url: string;
	title: string;
	summary: string | null;
	published_at: number;
	fetched_at: number;
	status: ScoreRow["status"] | null;
	rescore_version: number | null;
	rescore_status: string | null;
	rescore_error: string | null;
	rescore_requested_at: number | null;
	rescore_next_attempt_at: number | null;
};

/**
 * ニュースと運用の採点、運用の採点の置き換えのうち最後に頼んだもの（終わっていないもの）を結ぶ。
 * 採点し直しの列は news_scores と名前がぶつかるので別名で取る
 */
const NEWS_FROM = `from news n left join news_scores s on s.news_id = n.id
	left join news_rescores r on r.rowid = (
	  select x.rowid from news_rescores x where x.news_id = n.id and x.replace_requested_at is not null
	  order by x.replace_requested_at desc, x.criteria_version desc limit 1)`;
const NEWS_COLUMNS =
	"n.*, s.*, r.criteria_version as rescore_version, r.status as rescore_status, r.error as rescore_error, r.requested_at as rescore_requested_at, r.next_attempt_at as rescore_next_attempt_at";

const toSource = (r: SourceRow): NewsSource => ({
	id: r.id,
	name: r.name,
	url: r.url,
	language: r.language,
	enabled: r.enabled === 1,
	createdAt: r.created_at,
	lastSuccessAt: r.last_success_at,
	lastError: r.last_error,
	errorSince: r.error_since,
});

const toNewsItem = (r: NewsRow): Omit<NewsItem, "rescore"> => ({
	id: r.id,
	sourceId: r.source_id,
	sourceName: r.source_name,
	language: r.language,
	url: r.url,
	title: r.title,
	summary: r.summary,
	publishedAt: r.published_at,
	fetchedAt: r.fetched_at,
	score: r.status === null ? null : toNewsScore({ ...r, status: r.status }),
});

const INTERVAL_KEY = "news_interval_minutes";
const SEEDED_KEY = "news_sources_seeded";

export class NewsRepository {
	constructor(
		private readonly db: Db,
		private readonly now: () => number = Date.now,
	) {}

	private get sql() {
		return this.db.$client;
	}

	/** 行を記事にする。採点し直しの順番は ScoreRepository.nextToRescore と同じ並びで数える */
	private toItems(rows: NewsRow[]): NewsItem[] {
		const now = this.now();
		const ahead = this.sql.query<
			{ c: number },
			[number, number, number, number]
		>(
			`select count(*) as c from news_rescores y join news m on m.id = y.news_id
			 where (y.status = 'queued' or (y.status = 'retry' and y.next_attempt_at <= ?1))
			   and (y.requested_at, m.fetched_at, m.id) < (?2, ?3, ?4)`,
		);
		const rescore = (r: NewsRow): LiveRescore | null => {
			if (r.rescore_version === null) return null;
			const base = {
				version: r.rescore_version,
				ahead: null,
				nextAttemptAt: null,
				error: r.rescore_error,
			};
			if (r.rescore_status === "failed") return { ...base, status: "failed" };
			const next = r.rescore_next_attempt_at;
			if (r.rescore_status === "retry" && next !== null && next > now)
				return { ...base, status: "retry", nextAttemptAt: next };
			return {
				...base,
				status: "waiting",
				ahead:
					ahead.get(now, r.rescore_requested_at ?? 0, r.fetched_at, r.id)?.c ??
					0,
			};
		};
		return rows.map((r) => ({ ...toNewsItem(r), rescore: rescore(r) }));
	}

	listSources(): NewsSource[] {
		return this.sql
			.query<SourceRow, []>("select * from news_sources order by id")
			.all()
			.map(toSource);
	}

	getSource(id: number): NewsSource | null {
		const r = this.sql
			.query<SourceRow, [number]>("select * from news_sources where id = ?")
			.get(id);
		return r ? toSource(r) : null;
	}

	sourceByUrl(url: string): NewsSource | null {
		const r = this.sql
			.query<SourceRow, [string]>("select * from news_sources where url = ?")
			.get(url);
		return r ? toSource(r) : null;
	}

	insertSource(input: NewsSourceInput, createdAt: number): NewsSource {
		const r = this.sql
			.query<SourceRow, [string, string, string, number]>(
				"insert into news_sources (name, url, language, enabled, created_at) values (?, ?, ?, 1, ?) returning *",
			)
			.get(input.name, input.url, input.language, createdAt) as SourceRow;
		return toSource(r);
	}

	updateSource(id: number, patch: { enabled?: boolean; name?: string }) {
		if (patch.enabled !== undefined) {
			// 無効にしたら失敗の記録も消す（止まっている表示を残さないため）
			this.sql.run(
				patch.enabled
					? "update news_sources set enabled = 1 where id = ?"
					: "update news_sources set enabled = 0, last_error = null, error_since = null where id = ?",
				[id],
			);
		}
		if (patch.name !== undefined) {
			this.sql.run("update news_sources set name = ? where id = ?", [
				patch.name,
				id,
			]);
		}
	}

	removeSource(id: number): boolean {
		return (
			this.sql.run("delete from news_sources where id = ?", [id]).changes > 0
		);
	}

	/** 既定の取得元を1度だけ入れる。利用者が消した取得元を起動のたびに戻さないため、入れたことを覚えておく */
	seedSources(defaults: readonly NewsSourceInput[], now: number) {
		this.sql.transaction(() => {
			const seeded = this.sql
				.query("select 1 from settings where key = ?")
				.get(SEEDED_KEY);
			if (seeded) return;
			for (const s of defaults) {
				if (!this.sourceByUrl(s.url)) this.insertSource(s, now);
			}
			this.sql.run("insert into settings (key, value) values (?, '1')", [
				SEEDED_KEY,
			]);
		})();
	}

	intervalMinutes(fallback: number): number {
		const r = this.sql
			.query<{ value: string }, [string]>(
				"select value from settings where key = ?",
			)
			.get(INTERVAL_KEY);
		return r ? Number(r.value) : fallback;
	}

	setIntervalMinutes(minutes: number) {
		this.sql.run(
			"insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
			[INTERVAL_KEY, String(minutes)],
		);
	}

	/** 取得できた記事を保存する。同じ URL の記事は保存しない。保存した件数を返す */
	saveFetched(
		source: NewsSource,
		items: readonly FeedItem[],
		fetchedAt: number,
	) {
		return this.sql.transaction(() => {
			let inserted = 0;
			const insert = this.sql.query<
				unknown,
				[number, string, string, string, string, string | null, number, number]
			>(
				"insert into news (source_id, source_name, language, url, title, summary, published_at, fetched_at) values (?, ?, ?, ?, ?, ?, ?, ?) on conflict (url) do nothing",
			);
			for (const i of items) {
				const r = insert.run(
					source.id,
					source.name,
					source.language,
					i.url,
					i.title,
					i.summary,
					i.publishedAt ?? fetchedAt,
					fetchedAt,
				);
				inserted += r.changes;
			}
			this.sql.run(
				"update news_sources set last_success_at = ?, last_error = null, error_since = null where id = ?",
				[fetchedAt, source.id],
			);
			return inserted;
		})();
	}

	recordFailure(sourceId: number, error: string, at: number) {
		this.sql.run(
			"update news_sources set last_error = ?, error_since = coalesce(error_since, ?) where id = ?",
			[error, at, sourceId],
		);
	}

	listNews(limit: number): NewsItem[] {
		const rows = this.sql
			.query<NewsRow, [number]>(
				`select ${NEWS_COLUMNS} ${NEWS_FROM} order by n.published_at desc, n.id desc limit ?`,
			)
			.all(limit);
		return this.toItems(rows);
	}

	/** 条件で絞る。影響の大きさは rule の評価基準で測る */
	searchNews(f: NewsFilter, rule: AggregationRule): NewsSearchResult {
		const where: string[] = [];
		const args: (number | string)[] = [];
		if (f.from !== null) {
			where.push("n.published_at >= ?");
			args.push(f.from);
		}
		if (f.to !== null) {
			where.push("n.published_at < ?");
			args.push(f.to);
		}
		for (const word of f.q.split(/\s+/).filter(Boolean)) {
			const like = `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
			where.push(
				"(n.title like ? escape '\\' or n.summary like ? escape '\\' or (s.status = 'done' and s.comment like ? escape '\\'))",
			);
			args.push(like, like, like);
		}
		const impacts: string[] = [];
		const t = rule.thresholds;
		if (f.impacts.includes("bull")) {
			impacts.push("s.sentiment >= ?");
			args.push(t.sentiment.plus1);
		}
		if (f.impacts.includes("bear")) {
			impacts.push("s.sentiment < ?");
			args.push(t.sentiment.minus1);
		}
		if (f.impacts.includes("risk")) {
			impacts.push("s.risk >= ?");
			args.push(t.risk.alert);
		}
		if (impacts.length) {
			where.push(
				`(s.status = 'done' and s.duration != 'none' and (${impacts.join(" or ")}))`,
			);
		}
		if (f.durations.length) {
			where.push(
				`(s.status = 'done' and s.duration in (${f.durations.map(() => "?").join(",")}))`,
			);
			args.push(...f.durations);
		}
		if (f.activeAt !== null) {
			// core の newsWeight が 0 より大きいもの。新しさの時刻は公開時刻と取得時刻の早いほう
			where.push(
				`(s.status = 'done' and s.scored_at <= ? and ? - min(n.published_at, n.fetched_at) < case s.duration ${LASTING_DURATIONS.map(() => "when ? then ?").join(" ")} else 0 end)`,
			);
			args.push(
				f.activeAt,
				f.activeAt,
				...LASTING_DURATIONS.flatMap((d) => [d, windowMs(d, rule)]),
			);
		}
		const from = `${NEWS_FROM}${where.length ? ` where ${where.join(" and ")}` : ""}`;
		// 採点済みでないものは影響の大きい順では最後
		const order =
			f.sort === "impact"
				? "case when s.status = 'done' then max(abs(coalesce(s.sentiment, 0)), coalesce(s.risk, 0)) else -1 end desc, n.published_at desc, n.id desc"
				: "n.published_at desc, n.id desc";
		const total =
			this.sql
				.query<{ c: number }, (number | string)[]>(
					`select count(*) as c ${from}`,
				)
				.get(...args)?.c ?? 0;
		const rows = this.sql
			.query<NewsRow, (number | string)[]>(
				`select ${NEWS_COLUMNS} ${from} order by ${order} limit ?`,
			)
			.all(...args, f.limit);
		return { news: this.toItems(rows), total };
	}

	/** ID で引く。無い ID は飛ばす。並びは ids の順 */
	newsByIds(ids: readonly number[]): NewsItem[] {
		if (ids.length === 0) return [];
		const rows = this.sql
			.query<NewsRow, number[]>(
				`select ${NEWS_COLUMNS} ${NEWS_FROM} where n.id in (${ids.map(() => "?").join(",")})`,
			)
			.all(...ids);
		const byId = new Map(this.toItems(rows).map((r) => [r.id, r]));
		return ids.flatMap((id) => byId.get(id) ?? []);
	}
}
