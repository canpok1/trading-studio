// 採点の分析で読むニュースと採点。読むだけで書き換えない。書くのは精度の設定だけ

import type { Db } from "../db/open";
import type { AccuracySettings } from "./types";
import { DEFAULT_ACCURACY_SETTINGS } from "./types";

/** ニュースと採点。採点の行が無ければ status は null */
export type AnalysisNewsRow = {
	id: number;
	sourceName: string;
	language: string;
	url: string;
	title: string;
	summary: string | null;
	publishedAt: number;
	fetchedAt: number;
	status: string | null;
	risk: number | null;
	sentiment: number | null;
	comment: string | null;
	scoredAt: number | null;
	criteriaVersion: number | null;
	model: string | null;
	appBuiltAt: number | null;
	error: string | null;
};

/** ある版の採点。scoredAt は運用の採点時刻（判定に使い始める時刻） */
export type VersionScoreRow = {
	id: number;
	title: string;
	url: string;
	sourceName: string;
	publishedAt: number;
	scoredAt: number;
	version: number;
	sentiment: number | null;
	risk: number | null;
	comment: string | null;
};

/** 絞り込み。status の unscored は採点の行が無いもの */
export type NewsFilter = {
	from: number;
	to: number;
	criteriaVersion?: number;
	status?: "done" | "retry" | "failed" | "skipped" | "unscored";
};

const COLUMNS = `n.id, n.source_name as sourceName, n.language, n.url, n.title, n.summary,
  n.published_at as publishedAt, n.fetched_at as fetchedAt, s.status, s.risk, s.sentiment,
  s.comment, s.scored_at as scoredAt, s.criteria_version as criteriaVersion, s.model,
  s.app_built_at as appBuiltAt, s.error`;

const ACCURACY_SETTINGS_KEY = "accuracy_settings";

export class ScoringAnalysisRepository {
	constructor(private readonly db: Db) {}

	private get sql() {
		return this.db.$client;
	}

	accuracySettings(): AccuracySettings {
		const r = this.sql
			.query<{ value: string }, [string]>(
				"select value from settings where key = ?",
			)
			.get(ACCURACY_SETTINGS_KEY);
		return {
			...DEFAULT_ACCURACY_SETTINGS,
			...(r ? (JSON.parse(r.value) as Partial<AccuracySettings>) : {}),
		};
	}

	saveAccuracySettings(s: AccuracySettings) {
		this.sql.run(
			"insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
			[ACCURACY_SETTINGS_KEY, JSON.stringify(s)],
		);
	}

	private where(f: NewsFilter): { clause: string; args: (number | string)[] } {
		// 新しさの時刻（公開時刻と取得時刻の早いほう）で期間を絞る。集計・エクスポートと同じ基準
		const conds = [
			"min(n.published_at, n.fetched_at) >= ?",
			"min(n.published_at, n.fetched_at) < ?",
		];
		const args: (number | string)[] = [f.from, f.to];
		if (f.criteriaVersion !== undefined) {
			conds.push("s.criteria_version = ?");
			args.push(f.criteriaVersion);
		}
		if (f.status === "unscored") {
			conds.push("s.news_id is null");
		} else if (f.status !== undefined) {
			conds.push("s.status = ?");
			args.push(f.status);
		}
		return { clause: conds.join(" and "), args };
	}

	/** 新しい順（新しさの時刻） */
	news(
		f: NewsFilter,
		offset: number,
		limit: number,
	): { total: number; rows: AnalysisNewsRow[] } {
		const { clause, args } = this.where(f);
		const from = "from news n left join news_scores s on s.news_id = n.id";
		const total =
			this.sql
				.query<{ c: number }, (number | string)[]>(
					`select count(*) as c ${from} where ${clause}`,
				)
				.get(...args)?.c ?? 0;
		const rows = this.sql
			.query<AnalysisNewsRow, (number | string)[]>(
				`select ${COLUMNS} ${from} where ${clause}
				 order by min(n.published_at, n.fetched_at) desc, n.id desc limit ? offset ?`,
			)
			.all(...args, limit, offset);
		return { total, rows };
	}

	/** 採点済みのものを古い順（採点時刻）にすべて */
	scored(f: Omit<NewsFilter, "status">): AnalysisNewsRow[] {
		const { clause, args } = this.where({ ...f, status: "done" });
		return this.sql
			.query<AnalysisNewsRow, (number | string)[]>(
				`select ${COLUMNS} from news n join news_scores s on s.news_id = n.id
				 where ${clause} order by s.scored_at, n.id`,
			)
			.all(...args);
	}

	/** ID で引く。無い ID は飛ばす。並びは ids の順 */
	byIds(ids: readonly number[]): AnalysisNewsRow[] {
		if (ids.length === 0) return [];
		const rows = this.sql
			.query<AnalysisNewsRow, number[]>(
				`select ${COLUMNS} from news n left join news_scores s on s.news_id = n.id
				 where n.id in (${ids.map(() => "?").join(",")})`,
			)
			.all(...ids);
		const byId = new Map(rows.map((r) => [r.id, r]));
		return ids.flatMap((id) => byId.get(id) ?? []);
	}

	/**
	 * 新しさの時刻が [from, to) の記事の、版ごとの採点。運用の採点と採点し直したものを合わせ、同じ記事と版の組は運用の採点を優先する。
	 * 運用で採点済みでない記事は、値動きを測る起点が無いので除く
	 */
	versionScores(from: number, to: number): VersionScoreRow[] {
		const rows = this.sql
			.query<VersionScoreRow & { pri: number }, number[]>(
				`select n.id, n.title, n.url, n.source_name as sourceName, n.published_at as publishedAt,
				   s.scored_at as scoredAt, v.version, v.sentiment, v.risk, v.comment, v.pri
				 from news n
				 join news_scores s on s.news_id = n.id and s.status = 'done' and s.scored_at is not null
				 join (
				   select news_id, criteria_version as version, sentiment, risk, comment, 0 as pri
				     from news_scores where status = 'done' and criteria_version is not null
				   union all
				   select news_id, criteria_version, sentiment, risk, comment, 1
				     from news_rescores where status = 'done'
				 ) v on v.news_id = n.id
				 where min(n.published_at, n.fetched_at) >= ? and min(n.published_at, n.fetched_at) < ?
				 order by n.id, v.version, v.pri`,
			)
			.all(from, to);
		const seen = new Set<string>();
		return rows.flatMap(({ pri: _, ...r }) => {
			const key = `${r.id}:${r.version}`;
			if (seen.has(key)) return [];
			seen.add(key);
			return [r];
		});
	}
}
