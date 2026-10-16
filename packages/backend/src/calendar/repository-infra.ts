import type {
	CalendarRange,
	EventImportance,
	ScheduledEvent,
} from "@trading-studio/core";
import { mergeRanges } from "@trading-studio/core";
import type { Db } from "../db/open-infra";
import type {
	CalendarRepository,
	EventRow,
	EventSourceRow,
	JudgeTarget,
} from "./repository-domain";
import type {
	EventCriteriaVersion,
	EventJudgment,
	EventSourceInput,
	JudgmentCoverage,
	ListedEvent,
} from "./types-domain";

const ACTIVE_CRITERIA_KEY = "event_criteria_version";

type SourceRow = {
	id: number;
	name: string;
	url: string;
	created_at: number;
	last_success_at: number | null;
	last_error: string | null;
	error_since: number | null;
};

const toSource = (r: SourceRow): EventSourceRow => ({
	id: r.id,
	name: r.name,
	url: r.url,
	createdAt: r.created_at,
	lastSuccessAt: r.last_success_at,
	lastError: r.last_error,
	errorSince: r.error_since,
});

type CriteriaRow = {
	version: number;
	text: string;
	note: string;
	created_at: number;
};

const toCriteria = (r: CriteriaRow): EventCriteriaVersion => ({
	version: r.version,
	text: r.text,
	note: r.note,
	createdAt: r.created_at,
});

type TargetRow = {
	eventId: number;
	attempts: number | null;
	sourceName: string | null;
	title: string;
	description: string | null;
	start: number;
	allDay: number;
};

type ListedRow = {
	id: number;
	title: string;
	description: string | null;
	start: number;
	end: number;
	all_day: number;
	source_name: string | null;
	status: "pending" | "retry" | "failed" | "done" | null;
	importance: EventImportance | null;
	reason: string | null;
	judged_at: number | null;
	model: string | null;
	attempts: number | null;
	error: string | null;
	next_attempt_at: number | null;
};

function toJudgment(r: ListedRow): EventJudgment | null {
	const attempts = r.attempts ?? 0;
	switch (r.status) {
		case null:
			return null;
		case "done":
			return {
				status: "done",
				importance: r.importance as EventImportance,
				reason: r.reason ?? "",
				judgedAt: r.judged_at ?? 0,
				model: r.model ?? "",
			};
		case "failed":
			return { status: "failed", attempts, error: r.error ?? "" };
		default:
			return {
				status: r.status,
				attempts,
				error: r.error,
				nextAttemptAt: r.next_attempt_at,
			};
	}
}

const toListed = (r: ListedRow): ListedEvent => ({
	id: r.id,
	title: r.title,
	description: r.description,
	start: r.start,
	end: r.end,
	allDay: r.all_day === 1,
	sourceName: r.source_name,
	judgment: toJudgment(r),
});

const toTarget = (r: TargetRow, criteriaVersion: number): JudgeTarget => ({
	eventId: r.eventId,
	criteriaVersion,
	attempts: r.attempts ?? 0,
	sourceName: r.sourceName,
	title: r.title,
	description: r.description,
	start: r.start,
	allDay: r.allDay === 1,
});

const TARGET_COLUMNS = `e.id as eventId, j.attempts as attempts, s.name as sourceName,
	e.title as title, e.description as description, e.start as start, e.all_day as allDay`;

/** 判断がまだ無いか、再試行の時刻が来たもの（?2 が今の時刻）。失敗して止めたものも判断し直す時刻が来れば含める */
const UNJUDGED = `(j.event_id is null or (j.status in ('pending', 'retry', 'failed')
	and (j.next_attempt_at is null or j.next_attempt_at <= ?2)))`;

/** 予定が消えておらず、件名が判断を始めたときのままか（?1 が予定、?9 が件名） */
const SAME_EVENT =
	"exists (select 1 from scheduled_events where id = ?1 and title = ?9)";

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
			.query<SourceRow, [string, string, number]>(
				`insert into event_sources (name, url, created_at) values (?, ?, ?) returning *`,
			)
			.get(input.name, input.url, createdAt) as SourceRow;
		return toSource(r);
	}

	updateSource(id: number, input: EventSourceInput): void {
		const prev = this.getSource(id);
		if (!prev) return;
		this.sql.transaction(() => {
			this.sql
				.query("update event_sources set name = ?, url = ? where id = ?")
				.run(input.name, input.url, id);
			if (prev.url === input.url) return;
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
		// 判断は予定と一緒に消える（外部キーの cascade）
		this.sql.query("delete from scheduled_events where source_id = ?").run(id);
		this.sql.query("delete from event_coverage where source_id = ?").run(id);
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
		events: readonly EventRow[],
		range: CalendarRange,
		listed: CalendarRange,
		at: number,
	): void {
		this.sql.transaction(() => {
			const existing = new Map(
				this.sql
					.query<
						{
							id: number;
							uid: string;
							title: string;
							description: string | null;
						},
						[number]
					>(
						"select id, uid, title, description from scheduled_events where source_id = ?",
					)
					.all(sourceId)
					.map((r) => [r.uid, r]),
			);
			const insert = this.sql.query(
				`insert into scheduled_events (source_id, uid, title, description, start, end, all_day)
				 values (?, ?, ?, ?, ?, ?, ?)`,
			);
			const update = this.sql.query(
				`update scheduled_events set title = ?, description = ?, start = ?, end = ?, all_day = ?
				 where id = ?`,
			);
			const forget = this.sql.query(
				"delete from event_judgments where event_id = ?",
			);
			const seen = new Set<string>();
			for (const e of events) {
				if (seen.has(e.uid)) continue;
				seen.add(e.uid);
				const prev = existing.get(e.uid);
				if (!prev) {
					insert.run(
						sourceId,
						e.uid,
						e.title,
						e.description,
						e.start,
						e.end,
						e.allDay ? 1 : 0,
					);
					continue;
				}
				update.run(
					e.title,
					e.description,
					e.start,
					e.end,
					e.allDay ? 1 : 0,
					prev.id,
				);
				// 件名が変われば重要度も変わりうるので判断し直す。説明は発表後に結果を書き足す取得元があり、
				// そのたびに判断し直すと判断が済むまで暦切れになるので見ない
				if (prev.title !== e.title) {
					forget.run(prev.id);
				}
			}
			const gone = this.sql.query("delete from scheduled_events where id = ?");
			for (const r of this.sql
				.query<{ id: number; uid: string }, [number, number, number]>(
					`select id, uid from scheduled_events where source_id = ? and start >= ? and start < ?`,
				)
				.all(sourceId, listed.from, listed.until)) {
				if (!seen.has(r.uid)) gone.run(r.id);
			}
			const kept = this.sql
				.query<{ from: number; until: number }, [number]>(
					`select "from", until from event_coverage where source_id = ?`,
				)
				.all(sourceId);
			this.sql
				.query("delete from event_coverage where source_id = ?")
				.run(sourceId);
			for (const r of mergeRanges([...kept, range])) {
				this.sql
					.query(
						`insert into event_coverage (source_id, "from", until) values (?, ?, ?)`,
					)
					.run(sourceId, r.from, r.until);
			}
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

	seedBundled(events: readonly EventRow[]): void {
		const have = new Set(
			this.sql
				.query<{ uid: string }, []>(
					"select uid from scheduled_events where source_id is null",
				)
				.all()
				.map((r) => r.uid),
		);
		const insert = this.sql.query(
			`insert into scheduled_events (source_id, uid, title, description, start, end, all_day)
			 values (null, ?, ?, ?, ?, ?, ?)`,
		);
		this.sql.transaction(() => {
			for (const e of events) {
				if (have.has(e.uid)) continue;
				insert.run(
					e.uid,
					e.title,
					e.description,
					e.start,
					e.end,
					e.allDay ? 1 : 0,
				);
			}
		})();
	}

	coverage(): CalendarRange[] {
		return this.sql
			.query<{ from: number; until: number }, []>(
				`select "from", until from event_coverage order by "from"`,
			)
			.all();
	}

	seedCriteria(text: string, now: number) {
		this.sql.transaction(() => {
			if (this.listCriteria().length > 0) return;
			const v = this.addCriteria(text, "初版", now);
			this.setActiveCriteria(v.version);
		})();
	}

	listCriteria(): EventCriteriaVersion[] {
		return this.sql
			.query<CriteriaRow, []>("select * from event_criteria order by version")
			.all()
			.map(toCriteria);
	}

	getCriteria(version: number): EventCriteriaVersion | null {
		const r = this.sql
			.query<CriteriaRow, [number]>(
				"select * from event_criteria where version = ?",
			)
			.get(version);
		return r ? toCriteria(r) : null;
	}

	addCriteria(text: string, note: string, now: number): EventCriteriaVersion {
		const r = this.sql
			.query<CriteriaRow, [string, string, number]>(
				"insert into event_criteria (text, note, created_at) values (?, ?, ?) returning *",
			)
			.get(text, note, now) as CriteriaRow;
		return toCriteria(r);
	}

	activeCriteriaVersion(): number | null {
		const r = this.sql
			.query<{ value: string }, [string]>(
				"select value from settings where key = ?",
			)
			.get(ACTIVE_CRITERIA_KEY);
		return r ? Number(r.value) : null;
	}

	setActiveCriteria(version: number): void {
		this.sql
			.query(
				`insert into settings (key, value) values (?, ?)
				 on conflict (key) do update set value = excluded.value`,
			)
			.run(ACTIVE_CRITERIA_KEY, String(version));
	}

	events(version: number | null): ScheduledEvent[] {
		return this.sql
			.query<
				{
					title: string;
					start: number;
					end: number;
					importance: EventImportance | null;
				},
				[number]
			>(
				`select e.title, e.start, e.end, j.importance from scheduled_events e
				 left join event_judgments j on j.event_id = e.id and j.criteria_version = ?
				 and j.status = 'done'
				 order by e.start, e.end, e.id`,
			)
			.all(version ?? -1);
	}

	nextUnjudged(
		version: number,
		range: CalendarRange,
		order: "asc" | "desc",
		now: number,
	): JudgeTarget | null {
		const r = this.sql
			.query<TargetRow, [number, number, number, number]>(
				`select ${TARGET_COLUMNS} from scheduled_events e
				 left join event_sources s on s.id = e.source_id
				 left join event_judgments j on j.event_id = e.id and j.criteria_version = ?1
				 where ${UNJUDGED} and e.end >= ?3 and e.start < ?4
				 order by e.start ${order}, e.id limit 1`,
			)
			.get(version, now, range.from, range.until);
		return r ? toTarget(r, version) : null;
	}

	nextRequested(now: number): JudgeTarget | null {
		const r = this.sql
			.query<TargetRow & { criteriaVersion: number }, [number]>(
				`select ${TARGET_COLUMNS}, j.criteria_version as criteriaVersion
				 from event_judgments j
				 join scheduled_events e on e.id = j.event_id
				 left join event_sources s on s.id = e.source_id
				 where j.status in ('pending', 'retry')
				 and (j.next_attempt_at is null or j.next_attempt_at <= ?1)
				 order by j.requested_at, e.start, e.id limit 1`,
			)
			.get(now);
		return r ? toTarget(r, r.criteriaVersion) : null;
	}

	saveJudgment(
		t: JudgeTarget,
		r: { importance: EventImportance; reason: string },
		meta: {
			judgedAt: number;
			model: string;
			appBuiltAt: number | null;
			attempts: number;
		},
	): void {
		this.sql
			.query(
				`insert into event_judgments (event_id, criteria_version, status, importance, reason,
				 judged_at, model, app_built_at, attempts, error, next_attempt_at, requested_at)
				 select ?1, ?2, 'done', ?3, ?4, ?5, ?6, ?7, ?8, null, null, ?5 where ${SAME_EVENT}
				 on conflict (event_id, criteria_version) do update set status = 'done',
				 importance = ?3, reason = ?4, judged_at = ?5, model = ?6, app_built_at = ?7,
				 attempts = ?8, error = null, next_attempt_at = null`,
			)
			.run(
				t.eventId,
				t.criteriaVersion,
				r.importance,
				r.reason,
				meta.judgedAt,
				meta.model,
				meta.appBuiltAt,
				meta.attempts,
				t.title,
			);
	}

	saveJudgmentFailure(
		t: JudgeTarget,
		error: string,
		attempts: number,
		stopped: boolean,
		nextAttemptAt: number,
		now: number,
	): void {
		this.sql
			.query(
				`insert into event_judgments (event_id, criteria_version, status, attempts, error,
				 next_attempt_at, requested_at)
				 select ?1, ?2, ?3, ?4, ?5, ?6, ?7 where ${SAME_EVENT}
				 on conflict (event_id, criteria_version) do update set status = ?3,
				 attempts = ?4, error = ?5, next_attempt_at = ?6, importance = null, reason = null`,
			)
			.run(
				t.eventId,
				t.criteriaVersion,
				stopped ? "failed" : "retry",
				attempts,
				error,
				nextAttemptAt,
				now,
				null,
				t.title,
			);
	}

	judgmentCoverage(
		from: number,
		to: number,
		version: number,
	): JudgmentCoverage {
		const r = this.sql
			.query<
				{ total: number; done: number; pending: number; failed: number },
				[number, number, number]
			>(
				`select count(*) as total,
				 coalesce(sum(j.status = 'done'), 0) as done,
				 coalesce(sum(j.status in ('pending', 'retry')), 0) as pending,
				 coalesce(sum(j.status = 'failed'), 0) as failed
				 from scheduled_events e
				 left join event_judgments j on j.event_id = e.id and j.criteria_version = ?3
				 where e.start <= ?2 and e.end >= ?1`,
			)
			.get(from, to, version);
		return r ?? { total: 0, done: 0, pending: 0, failed: 0 };
	}

	requestJudgments(
		from: number,
		to: number,
		version: number,
		now: number,
	): void {
		this.sql.transaction(() => {
			this.sql
				.query(
					`insert into event_judgments (event_id, criteria_version, status, attempts, requested_at)
					 select e.id, ?3, 'pending', 0, ?4 from scheduled_events e
					 where e.start <= ?2 and e.end >= ?1
					 on conflict (event_id, criteria_version) do update set status = 'pending',
					 attempts = 0, error = null, next_attempt_at = null, requested_at = ?4
					 where event_judgments.status = 'failed'`,
				)
				.run(from, to, version, now);
		})();
	}

	unjudgedCount(version: number): number {
		const r = this.sql
			.query<{ n: number }, [number]>(
				`select count(*) as n from scheduled_events e
				 left join event_judgments j on j.event_id = e.id and j.criteria_version = ?
				 where j.event_id is null or j.status in ('pending', 'retry')`,
			)
			.get(version);
		return r?.n ?? 0;
	}

	listEvents(
		from: number,
		to: number,
		version: number,
		importances: readonly EventImportance[] | null,
		limit: number,
	): { events: ListedEvent[]; total: number } {
		const keep =
			importances === null
				? ""
				: `and (j.status is null or j.status != 'done' or j.importance in (${importances.map((i) => `'${i}'`).join(", ")}))`;
		const where = `from scheduled_events e
			 left join event_sources s on s.id = e.source_id
			 left join event_judgments j on j.event_id = e.id and j.criteria_version = ?3
			 where e.start <= ?2 and e.end >= ?1 ${keep}`;
		const total =
			this.sql
				.query<{ n: number }, [number, number, number]>(
					`select count(*) as n ${where}`,
				)
				.get(from, to, version)?.n ?? 0;
		const rows = this.sql
			.query<ListedRow, [number, number, number, number]>(
				`select e.id, e.title, e.description, e.start, e.end, e.all_day, s.name as source_name,
				 j.status, j.importance, j.reason, j.judged_at, j.model, j.attempts, j.error, j.next_attempt_at
				 ${where} order by e.start, e.id limit ?4`,
			)
			.all(from, to, version, limit);
		return { events: rows.map(toListed), total };
	}

	requestJudgment(eventId: number, version: number, now: number): boolean {
		const r = this.sql
			.query(
				`update event_judgments set status = 'pending', attempts = 0, error = null,
				 next_attempt_at = null, requested_at = ?3
				 where event_id = ?1 and criteria_version = ?2 and status = 'failed'`,
			)
			.run(eventId, version, now);
		return r.changes > 0;
	}

	failedCount(version: number): number {
		const r = this.sql
			.query<{ n: number }, [number]>(
				`select count(*) as n from event_judgments
				 where criteria_version = ? and status = 'failed'`,
			)
			.get(version);
		return r?.n ?? 0;
	}
}
