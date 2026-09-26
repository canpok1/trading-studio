import type { Db } from "../db/open";
import type { FeedItem } from "./rss";
import { toNewsScore } from "./score-repository";
import type {
	NewsItem,
	NewsLanguage,
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
};

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

export const toNewsItem = (r: NewsRow): NewsItem => ({
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
	constructor(private readonly db: Db) {}

	private get sql() {
		return this.db.$client;
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
		return this.sql
			.query<NewsRow, [number]>(
				"select * from news n left join news_scores s on s.news_id = n.id order by n.published_at desc, n.id desc limit ?",
			)
			.all(limit)
			.map(toNewsItem);
	}
}
