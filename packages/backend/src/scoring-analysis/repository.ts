// 採点の分析で読むニュースと採点。読むだけで書き換えない

import type { Db } from "../db/open";

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

export class ScoringAnalysisRepository {
	constructor(private readonly db: Db) {}

	private get sql() {
		return this.db.$client;
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
}
