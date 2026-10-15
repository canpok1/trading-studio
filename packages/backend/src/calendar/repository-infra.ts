import type {
	CalendarRange,
	MarketEvent,
	ScheduledEvent,
} from "@trading-studio/core";
import { mergeRanges } from "@trading-studio/core";
import type { Db } from "../db/open-infra";
import type { CalendarRepository, EventSourceRow } from "./repository-domain";
import type { EventKeywords, EventSourceInput } from "./types-domain";

type SourceRow = {
	id: number;
	name: string;
	url: string;
	keywords: string;
	created_at: number;
	first_success_at: number | null;
	last_success_at: number | null;
	last_error: string | null;
	error_since: number | null;
};

const toSource = (r: SourceRow): EventSourceRow => ({
	id: r.id,
	name: r.name,
	url: r.url,
	keywords: JSON.parse(r.keywords) as EventKeywords,
	createdAt: r.created_at,
	firstSuccessAt: r.first_success_at,
	lastSuccessAt: r.last_success_at,
	lastError: r.last_error,
	errorSince: r.error_since,
});

export class SqliteCalendarRepository implements CalendarRepository {
	constructor(private readonly db: Db) {}

	private get sql() {
		return this.db.$client;
	}

	listSources(): EventSourceRow[] {
		return this.sql
			.query<SourceRow, []>("select * from event_sources order by id")
			.all()
			.map(toSource);
	}

	getSource(id: number): EventSourceRow | null {
		const r = this.sql
			.query<SourceRow, [number]>("select * from event_sources where id = ?")
			.get(id);
		return r ? toSource(r) : null;
	}

	sourceByUrl(url: string): EventSourceRow | null {
		const r = this.sql
			.query<SourceRow, [string]>("select * from event_sources where url = ?")
			.get(url);
		return r ? toSource(r) : null;
	}

	insertSource(input: EventSourceInput, createdAt: number): EventSourceRow {
		const r = this.sql
			.query<SourceRow, [string, string, string, number]>(
				`insert into event_sources (name, url, keywords, created_at)
				 values (?, ?, ?, ?) returning *`,
			)
			.get(
				input.name,
				input.url,
				JSON.stringify(input.keywords),
				createdAt,
			) as SourceRow;
		return toSource(r);
	}

	updateSource(id: number, input: EventSourceInput): void {
		const prev = this.getSource(id);
		if (!prev) return;
		const keywords = JSON.stringify(input.keywords);
		const reset =
			prev.url !== input.url || JSON.stringify(prev.keywords) !== keywords;
		this.sql.transaction(() => {
			this.sql
				.query(
					"update event_sources set name = ?, url = ?, keywords = ? where id = ?",
				)
				.run(input.name, input.url, keywords, id);
			if (!reset) return;
			this.clear(id);
			this.sql
				.query(
					`update event_sources set first_success_at = null, last_success_at = null,
					 last_error = null, error_since = null where id = ?`,
				)
				.run(id);
		})();
	}

	private clear(id: number) {
		this.sql.query("delete from calendar_events where source_id = ?").run(id);
		this.sql.query("delete from calendar_coverage where source_id = ?").run(id);
	}

	removeSource(id: number): boolean {
		return this.sql.transaction(() => {
			this.clear(id);
			return (
				this.sql.query("delete from event_sources where id = ?").run(id)
					.changes > 0
			);
		})();
	}

	saveFetched(
		sourceId: number,
		types: readonly MarketEvent[],
		events: readonly ScheduledEvent[],
		range: CalendarRange,
		listed: CalendarRange,
		at: number,
	): void {
		this.sql.transaction(() => {
			for (const type of types) {
				this.sql
					.query(
						`delete from calendar_events where source_id = ? and type = ?
						 and start >= ? and start < ?`,
					)
					.run(sourceId, type, listed.from, listed.until);
				const kept = this.sql
					.query<{ from: number; until: number }, [number, string]>(
						`select "from", until from calendar_coverage where source_id = ? and type = ?`,
					)
					.all(sourceId, type);
				this.sql
					.query(
						"delete from calendar_coverage where source_id = ? and type = ?",
					)
					.run(sourceId, type);
				for (const r of mergeRanges([...kept, range])) {
					this.sql
						.query(
							`insert into calendar_coverage (source_id, type, "from", until) values (?, ?, ?, ?)`,
						)
						.run(sourceId, type, r.from, r.until);
				}
			}
			const insert = this.sql.query(
				"insert into calendar_events (source_id, type, start, end) values (?, ?, ?, ?)",
			);
			for (const e of events) insert.run(sourceId, e.type, e.start, e.end);
			this.sql
				.query(
					`update event_sources set last_success_at = ?1,
					 first_success_at = coalesce(first_success_at, ?1),
					 last_error = null, error_since = null where id = ?2`,
				)
				.run(at, sourceId);
		})();
	}

	recordFailure(sourceId: number, error: string, at: number): void {
		this.sql
			.query(
				`update event_sources set last_error = ?, error_since = coalesce(error_since, ?)
				 where id = ?`,
			)
			.run(error, at, sourceId);
	}

	events(): ScheduledEvent[] {
		return this.sql
			.query<ScheduledEvent, []>(
				"select type, start, end from calendar_events order by start, end",
			)
			.all();
	}

	coverage(): { type: MarketEvent; range: CalendarRange }[] {
		return this.sql
			.query<{ type: MarketEvent; from: number; until: number }, []>(
				`select type, "from", until from calendar_coverage order by "from"`,
			)
			.all()
			.map((r) => ({ type: r.type, range: { from: r.from, until: r.until } }));
	}

	lastEventAt(): { sourceId: number; type: MarketEvent; start: number }[] {
		return this.sql
			.query<{ sourceId: number; type: MarketEvent; start: number }, []>(
				`select source_id as sourceId, type, max(start) as start from calendar_events
				 group by source_id, type`,
			)
			.all();
	}
}
