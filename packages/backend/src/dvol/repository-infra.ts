// DVOL の足と取得の状態。状態は settings に持つ

import type { Db } from "../db/open-infra";
import type { DvolFetchState, DvolRepository } from "./repository-domain";
import type { DvolBar } from "./types-domain";

const STATE_KEY = "dvol_fetch_state";

export class SqliteDvolRepository implements DvolRepository {
	constructor(private readonly db: Db) {}

	private get sql() {
		return this.db.$client;
	}

	save(bars: readonly DvolBar[]): void {
		const q = this.sql.query(
			`insert into dvol_bars (time, open, high, low, close) values (?, ?, ?, ?, ?)
			 on conflict (time) do update set open = excluded.open, high = excluded.high,
			   low = excluded.low, close = excluded.close`,
		);
		this.sql.transaction(() => {
			for (const b of bars) q.run(b.time, b.open, b.high, b.low, b.close);
		})();
	}

	latestTime(): number | null {
		return (
			this.sql
				.query<{ t: number | null }, []>("select max(time) as t from dvol_bars")
				.get()?.t ?? null
		);
	}

	bars(from: number, to: number): DvolBar[] {
		return this.sql
			.query<DvolBar, [number, number]>(
				"select time, open, high, low, close from dvol_bars where time >= ? and time < ? order by time",
			)
			.all(from, to);
	}

	count(from: number, to: number): number {
		return (
			this.sql
				.query<{ n: number }, [number, number]>(
					"select count(*) as n from dvol_bars where time >= ? and time < ?",
				)
				.get(from, to)?.n ?? 0
		);
	}

	deleteBars(from: number, to: number, limit: number): number {
		return this.sql.run(
			`delete from dvol_bars where time in (
			   select time from dvol_bars where time >= ? and time < ? limit ?)`,
			[from, to, limit],
		).changes;
	}

	fetchState(): DvolFetchState {
		const r = this.sql
			.query<{ value: string }, [string]>(
				"select value from settings where key = ?",
			)
			.get(STATE_KEY);
		return r
			? (JSON.parse(r.value) as DvolFetchState)
			: { lastSuccessAt: null, lastError: null, errorSince: null };
	}

	private writeState(s: DvolFetchState) {
		this.sql.run(
			"insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
			[STATE_KEY, JSON.stringify(s)],
		);
	}

	recordSuccess(at: number): void {
		this.writeState({ lastSuccessAt: at, lastError: null, errorSince: null });
	}

	recordFailure(error: string, at: number): void {
		const s = this.fetchState();
		this.writeState({
			...s,
			lastError: error,
			errorSince: s.errorSince ?? at,
		});
	}
}
