// 古いデータの削除。保持期間の設定と前回の結果は settings に持つ

import { DATASET_LEAD_MS } from "@trading-studio/core";
import type { Db } from "../db/open";
import { NEWS_DELETED_BEFORE_KEY } from "../news/score-repository";
import type { RetentionRun, RetentionSettings, RetentionTable } from "./types";

const SETTINGS_KEY = "retention_settings";
const LAST_RUN_KEY = "retention_last_run";

export const DEFAULT_RETENTION: RetentionSettings = {
	decisionsDays: 90,
	backtestsDays: null,
	marketDataYears: 5,
};

/** 画面に行数を出すテーブル */
const TABLES: readonly [string, string][] = [
	["trading_decisions", "判断の記録"],
	["trading_orders", "自動取引の注文"],
	["backtest_runs", "バックテストの実行"],
	["candles", "足"],
	["datasets", "データセット"],
	["news", "ニュース"],
];

export class RetentionRepository {
	constructor(private readonly db: Db) {}

	private get sql() {
		return this.db.$client;
	}

	private read<T>(key: string): T | null {
		const r = this.sql
			.query<{ value: string }, [string]>(
				"select value from settings where key = ?",
			)
			.get(key);
		return r ? (JSON.parse(r.value) as T) : null;
	}

	private write(key: string, value: unknown) {
		this.sql.run(
			"insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
			[key, JSON.stringify(value)],
		);
	}

	settings(): RetentionSettings {
		return {
			...DEFAULT_RETENTION,
			...this.read<RetentionSettings>(SETTINGS_KEY),
		};
	}

	saveSettings(s: RetentionSettings) {
		this.write(SETTINGS_KEY, s);
	}

	lastRun(): RetentionRun | null {
		return this.read<RetentionRun>(LAST_RUN_KEY);
	}

	saveLastRun(r: RetentionRun) {
		this.write(LAST_RUN_KEY, r);
	}

	/** before より前の判断の記録を最大 limit 件消す。注文を出した判断は残す。消した件数を返す */
	deleteDecisions(before: number, limit: number): number {
		return this.sql.run(
			`delete from trading_decisions where id in (
			   select d.id from trading_decisions d
			   where d.time < ?
			     and d.id not in (select decision_id from trading_orders where decision_id is not null)
			   limit ?)`,
			[before, limit],
		).changes;
	}

	/** before より前に始めたバックテストの実行を最大 limit 件、結果・アドバイスごと消す。実行中・アドバイスの生成中は残す */
	deleteBacktests(before: number, limit: number): number {
		const ids = this.sql
			.query<{ id: number }, [number, number]>(
				`select r.id from backtest_runs r
				 where r.started_at < ? and r.status != 'running'
				   and not exists (select 1 from backtest_advice a where a.run_id = r.id and a.status = 'running')
				 limit ?`,
			)
			.all(before, limit)
			.map((r) => r.id);
		if (ids.length === 0) return 0;
		const marks = ids.map(() => "?").join(", ");
		this.sql.transaction(() => {
			this.sql.run(
				`delete from backtest_advice where run_id in (${marks})`,
				ids,
			);
			this.sql.run(
				`delete from backtest_results where run_id in (${marks})`,
				ids,
			);
			this.sql.run(`delete from backtest_runs where id in (${marks})`, ids);
		})();
		return ids.length;
	}

	/** 開始が before より前のデータセットを、相場ごとに最新の1件を残して消す。消した件数を返す */
	pruneDatasets(before: number): number {
		return this.sql.run(
			`delete from datasets where from_time < ?1 and from_time < (
			   select max(k.from_time) from datasets k where k.regime = datasets.regime and k.from_time < ?1)`,
			[before],
		).changes;
	}

	/** 残っているデータセットのために残す範囲（開始の DATASET_LEAD_MS 前から終了まで） */
	keptRanges(): { from: number; to: number }[] {
		return this.sql
			.query<{ from_time: number; to_time: number }, []>(
				"select from_time, to_time from datasets",
			)
			.all()
			.map((d) => ({ from: d.from_time - DATASET_LEAD_MS, to: d.to_time }));
	}

	/** 公開が [from, to) のニュースを最大 limit 件、採点・採点し直しごと消す。消した件数を返す */
	deleteNews(from: number, to: number, limit: number): number {
		const ids = this.sql
			.query<{ id: number }, [number, number, number]>(
				"select id from news where published_at >= ? and published_at < ? limit ?",
			)
			.all(from, to, limit)
			.map((r) => r.id);
		if (ids.length === 0) return 0;
		const marks = ids.map(() => "?").join(", ");
		this.sql.transaction(() => {
			this.sql.run(
				`delete from news_rescores where news_id in (${marks})`,
				ids,
			);
			this.sql.run(`delete from news_scores where news_id in (${marks})`, ids);
			this.sql.run(`delete from news where id in (${marks})`, ids);
		})();
		return ids.length;
	}

	/** ニュースを消した境目を覚える。境目より前は市場評価の記録が無いものとする（judgmentRecordStart） */
	markNewsDeletedBefore(before: number) {
		const prev = this.read<number>(NEWS_DELETED_BEFORE_KEY);
		this.write(NEWS_DELETED_BEFORE_KEY, Math.max(prev ?? before, before));
	}

	/** DB ファイルの大きさと、そのうち空いている領域（バイト） */
	size(): { dbBytes: number; freeBytes: number } {
		const n = (pragma: string) =>
			Number(
				Object.values(
					this.sql
						.query<Record<string, number>, []>(`pragma ${pragma}`)
						.get() ?? {},
				)[0] ?? 0,
			);
		const pageSize = n("page_size");
		return {
			dbBytes: n("page_count") * pageSize,
			freeBytes: n("freelist_count") * pageSize,
		};
	}

	tables(): RetentionTable[] {
		return TABLES.map(([name, label]) => ({
			name,
			label,
			rows:
				this.sql
					.query<{ c: number }, []>(`select count(*) as c from ${name}`)
					.get()?.c ?? 0,
		}));
	}
}
