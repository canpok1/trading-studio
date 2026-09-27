// 古いデータの削除。保持期間の設定と前回の結果は settings に持つ

import type { Db } from "../db/open";
import type { RetentionRun, RetentionSettings, RetentionTable } from "./types";

const SETTINGS_KEY = "retention_settings";
const LAST_RUN_KEY = "retention_last_run";

export const DEFAULT_RETENTION: RetentionSettings = {
	decisionsDays: 90,
	backtestsDays: null,
};

/** 画面に行数を出すテーブル */
const TABLES: readonly [string, string][] = [
	["trading_decisions", "判断の記録"],
	["trading_orders", "自動取引の注文"],
	["backtest_runs", "バックテストの実行"],
	["candles", "足"],
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
