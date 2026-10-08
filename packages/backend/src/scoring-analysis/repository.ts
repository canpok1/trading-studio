// 精度を測るニュースと採点。読むだけで書き換えない。書くのは精度の設定だけ

import type { Duration } from "@trading-studio/core";
import type { Db } from "../db/open";
import { NEWS_TIME_SQL } from "../news/score-repository";
import type { AccuracySettings } from "./types";
import {
	ACCURACY_HORIZONS,
	ACCURACY_PERIODS,
	DEFAULT_ACCURACY_SETTINGS,
} from "./types";

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
	duration: Duration | null;
	comment: string | null;
	scoredAt: number | null;
	criteriaVersion: number | null;
	model: string | null;
	appBuiltAt: number | null;
	error: string | null;
};

const COLUMNS = `n.id, n.source_name as sourceName, n.language, n.url, n.title, n.summary,
  n.published_at as publishedAt, n.fetched_at as fetchedAt, s.status, s.risk, s.sentiment,
  s.duration, s.comment, s.scored_at as scoredAt, s.criteria_version as criteriaVersion, s.model,
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
		const d = DEFAULT_ACCURACY_SETTINGS;
		if (!r) return d;
		const v = JSON.parse(r.value) as Partial<AccuracySettings>;
		// リスクの境目は3段階（rough・wild の2つ）だった頃の保存値を読まず、既定にする
		const riskOk = ACCURACY_HORIZONS.every((h) => {
			const b = v.riskBands?.[h];
			return (
				b !== undefined &&
				[b.slight, b.rough, b.heavy, b.wild].every((x) => typeof x === "number")
			);
		});
		return {
			horizon: v.horizon ?? d.horizon,
			sentimentBands: v.sentimentBands ?? d.sentimentBands,
			riskBands: riskOk
				? (v.riskBands as AccuracySettings["riskBands"])
				: d.riskBands,
			// 期間を持つ前の保存値は既定にする。null（すべて）は有効な値
			periodDays:
				v.periodDays === undefined || !ACCURACY_PERIODS.includes(v.periodDays)
					? d.periodDays
					: v.periodDays,
		};
	}

	saveAccuracySettings(s: AccuracySettings) {
		this.sql.run(
			"insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
			[ACCURACY_SETTINGS_KEY, JSON.stringify(s)],
		);
	}

	/**
	 * 採点済みのものを、新しさの時刻（公開時刻と取得時刻の早い方）が (from, to] の範囲で。from が null なら to 以前すべて。
	 * to より後に採点したものは、その時点ではまだ無かったので除く
	 */
	publishedBetween(from: number | null, to: number): AnalysisNewsRow[] {
		const t = NEWS_TIME_SQL;
		// 公開時刻は新しさの時刻以上なので、下限は公開時刻のインデックスでも絞れる
		const lower = from === null ? "" : ` and n.published_at > ? and ${t} > ?`;
		return this.sql
			.query<AnalysisNewsRow, number[]>(
				`select ${COLUMNS} from news n join news_scores s on s.news_id = n.id
				 where s.status = 'done' and s.scored_at <= ? and ${t} <= ?${lower}
				 order by ${t}, n.id`,
			)
			.all(to, to, ...(from === null ? [] : [from, from]));
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
