// 予定イベントの暦の取得（設定の取得元の iCal を定期的に取って保存する）と、判定に使う暦の組み立て

import type {
	CalendarRange,
	EventCalendar,
	MarketEvent,
	ScheduledEvent,
} from "@trading-studio/core";
import {
	BUNDLED_EVENT_CALENDAR,
	combineCalendars,
	isMarketEvent,
	JST_OFFSET_MS,
	MARKET_EVENTS,
	mergeRanges,
} from "@trading-studio/core";
import type {
	CalendarRepository,
	EventSourceRow,
	IcalEvent,
} from "./repository-domain";
import type {
	CalendarService,
	EventKeywords,
	EventSource,
	EventSourceInput,
	EventSourceResult,
} from "./types-domain";

/** 取得元の予定を取る手段。テストでは偽物に差し替える */
export type FetchIcal = (url: string) => Promise<IcalEvent[]>;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const FETCH_INTERVAL_MS = 6 * HOUR_MS;
/**
 * 前回の取得からこの時間までなら、その間の暦もそろっているとみなす。
 * 今週の分だけを載せる取得元では、週の変わり目の前後がどちらの取得にも載らないため
 */
const CONTINUOUS_MS = DAY_MS;
/** 語を入れた種類がこの日数のあいだ1件も拾えなければ、拾えていない疑いとして知らせる（FOMC・日銀会合は間が7〜8週空く） */
const STALE_DAYS = 70;
const NAME_MAX = 40;
const KEYWORD_MAX = 100;

/** 取得元の入力を読む。形が違えば null */
export function parseEventSourceInput(v: unknown): EventSourceInput | null {
	if (typeof v !== "object" || v === null) return null;
	const { name, url, keywords } = v as Record<string, unknown>;
	if (
		typeof name !== "string" ||
		typeof url !== "string" ||
		typeof keywords !== "object" ||
		keywords === null ||
		!Object.entries(keywords).every(
			([k, w]) => isMarketEvent(k) && typeof w === "string",
		)
	) {
		return null;
	}
	return { name, url, keywords: keywords as EventKeywords };
}

function checkInput(
	input: EventSourceInput,
): { field: string; message: string } | null {
	const name = input.name.trim();
	if (!name) return { field: "name", message: "名前を入れる" };
	if (name.length > NAME_MAX)
		return { field: "name", message: `${NAME_MAX} 文字以内にする` };
	try {
		const u = new URL(normalizeUrl(input.url));
		if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
	} catch {
		return { field: "url", message: "http(s) の URL を入れる" };
	}
	const words = Object.values(input.keywords).map((w) => (w ?? "").trim());
	if (words.every((w) => w === ""))
		return { field: "keywords", message: "1つ以上の種類に語を入れる" };
	if (words.some((w) => w.length > KEYWORD_MAX))
		return { field: "keywords", message: `語は ${KEYWORD_MAX} 文字以内にする` };
	return null;
}

/** 購読用の webcal:// は https:// で取る */
const normalizeUrl = (url: string) =>
	url.trim().replace(/^webcals?:\/\//i, "https://");

function normalize(input: EventSourceInput): EventSourceInput {
	const keywords: EventKeywords = {};
	for (const t of MARKET_EVENTS) {
		const w = input.keywords[t]?.trim();
		if (w) keywords[t] = w;
	}
	return { name: input.name.trim(), url: normalizeUrl(input.url), keywords };
}

/** JST の日の 0:00 */
const jstDayStart = (t: number) =>
	Math.floor((t + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS;

/** 取得元に載っている予定のうち、そろっている期間に数えるのは取得した時刻の前後この範囲だけ（繰り返しの予定や遠い過去・先の予定で期間が広がりすぎないように） */
const LISTED_BEFORE_MS = 7 * DAY_MS;
const LISTED_AFTER_MS = 366 * DAY_MS;

/**
 * 取得した予定から、語に当たるものを暦にする。
 * 日銀会合は時刻が決まっていないので JST の日の 0:00〜24:00、ほかの種類も終日の予定はその日の 24 時間をイベントの時間にする。
 * そろっている期間は、載っている最初の予定（取得した時刻の LISTED_BEFORE_MS 前まで）から、
 * 最後の予定（同じく LISTED_AFTER_MS 後まで）か次の取得の予定時刻の遅いほうまで。
 * 前回の取得が CONTINUOUS_MS 以内なら、その時刻からそろっているとみなす
 */
export function toCalendar(
	items: readonly IcalEvent[],
	keywords: EventKeywords,
	fetchedAt: number,
	prevSuccessAt: number | null,
): {
	events: ScheduledEvent[];
	range: CalendarRange;
	/** 取得元の今の中身で置き換える期間 */
	listed: CalendarRange;
	types: MarketEvent[];
} {
	const types = MARKET_EVENTS.filter((t) => keywords[t]);
	const events: ScheduledEvent[] = [];
	for (const item of items) {
		const summary = item.summary.toLowerCase();
		for (const type of types) {
			if (!summary.includes((keywords[type] as string).toLowerCase())) continue;
			const start = type === "boj" ? jstDayStart(item.start) : item.start;
			const allDay = type === "boj" || item.allDay;
			events.push({ type, start, end: allDay ? start + DAY_MS : start });
		}
	}
	const starts = items
		.map((i) => i.start)
		.filter(
			(t) =>
				t >= fetchedAt - LISTED_BEFORE_MS && t <= fetchedAt + LISTED_AFTER_MS,
		);
	const first = Math.min(fetchedAt, ...starts);
	const last = Math.max(fetchedAt, ...starts);
	// 取得した時刻より後で載っていない予定は、移動か取り消しとみなす。前の予定は今週の分だけを載せる取得元で消えるので残す。
	// 日銀会合は日の 0:00 にずらして持つので、その分も含める
	const listed = {
		from: Math.min(first, ...events.map((e) => e.start)),
		until: Math.max(last, ...events.map((e) => e.start)) + 1,
	};
	const continuous =
		prevSuccessAt !== null && fetchedAt - prevSuccessAt <= CONTINUOUS_MS;
	const range = {
		from: continuous ? (prevSuccessAt as number) : first,
		// 次の取得までに載る予定は、次の取得で拾う。今週の分だけを載せる取得元で、週の最後の予定の後が暦切れにならないように
		until: Math.max(last + 1, fetchedAt + FETCH_INTERVAL_MS),
	};
	return { events, range, listed, types };
}

export type CalendarCollector = CalendarService & {
	/** 定期的に呼ぶ（main では1分ごと）。次の取得の時刻を過ぎていれば取得を始める */
	tick(): void;
	/** 取得を1回行う。すでに動いていれば、その回の終わりを待つ */
	run(): Promise<void>;
};

export function createCalendarService({
	repo,
	fetchIcal,
	now = Date.now,
}: {
	repo: CalendarRepository;
	fetchIcal: FetchIcal;
	now?: () => number;
}): CalendarCollector {
	let lastRunAt: number | null = null;
	let running: Promise<void> | null = null;
	let cached: EventCalendar | null = null;

	const nextRunAt = () =>
		lastRunAt === null ? null : lastRunAt + FETCH_INTERVAL_MS;

	async function fetchOne(source: EventSourceRow) {
		try {
			const items = await fetchIcal(source.url);
			// 取得中に消されたか、URL・語が変わっていたら保存しない
			const current = repo.getSource(source.id);
			if (
				!current ||
				current.url !== source.url ||
				JSON.stringify(current.keywords) !== JSON.stringify(source.keywords)
			) {
				return;
			}
			if (items.length === 0) throw new Error("予定が1件も無い");
			const at = now();
			const c = toCalendar(items, current.keywords, at, current.lastSuccessAt);
			repo.saveFetched(current.id, c.types, c.events, c.range, c.listed, at);
			cached = null;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			if (repo.getSource(source.id)) {
				repo.recordFailure(source.id, `取得できない: ${message}`, now());
			}
		}
	}

	async function runOnce() {
		lastRunAt = now();
		for (const source of repo.listSources()) await fetchOne(source);
	}

	function toSource(
		row: EventSourceRow,
		last: Map<string, number>,
		t: number,
	): EventSource {
		const { firstSuccessAt, ...rest } = row;
		const since = t - STALE_DAYS * DAY_MS;
		const stale =
			firstSuccessAt !== null && firstSuccessAt <= since
				? MARKET_EVENTS.filter(
						(type) =>
							row.keywords[type] &&
							(last.get(`${row.id}:${type}`) ?? Number.NEGATIVE_INFINITY) <
								since,
					)
				: [];
		return { ...rest, stale };
	}

	const sourceOf = (row: EventSourceRow) => toSource(row, lastMap(), now());
	const lastMap = () =>
		new Map(
			repo.lastEventAt().map((r) => [`${r.sourceId}:${r.type}`, r.start]),
		);

	function calendar(): EventCalendar {
		if (cached) return cached;
		const covered = Object.fromEntries(
			MARKET_EVENTS.map((t) => [t, [] as CalendarRange[]]),
		) as Record<MarketEvent, CalendarRange[]>;
		for (const c of repo.coverage()) covered[c.type].push(c.range);
		cached = combineCalendars([
			BUNDLED_EVENT_CALENDAR,
			{
				events: repo.events(),
				covered: Object.fromEntries(
					MARKET_EVENTS.map((t) => [t, mergeRanges(covered[t])]),
				) as Record<MarketEvent, CalendarRange[]>,
			},
		]);
		return cached;
	}

	function save(input: EventSourceInput, id: number | null): EventSourceResult {
		const bad = checkInput(input);
		if (bad) return { ok: false, kind: "invalid", ...bad };
		const v = normalize(input);
		const same = repo.sourceByUrl(v.url);
		if (same && same.id !== id) {
			return {
				ok: false,
				kind: "duplicate_url",
				message: "同じ URL の取得元がある",
			};
		}
		if (id === null) {
			const row = repo.insertSource(v, now());
			return { ok: true, source: sourceOf(row) };
		}
		if (!repo.getSource(id)) return { ok: false, kind: "not_found" };
		repo.updateSource(id, v);
		cached = null;
		return { ok: true, source: sourceOf(repo.getSource(id) as EventSourceRow) };
	}

	const service: CalendarCollector = {
		listSources() {
			const last = lastMap();
			const t = now();
			return repo.listSources().map((r) => toSource(r, last, t));
		},
		addSource: (input) => save(input, null),
		updateSource: (id, input) => save(input, id),
		removeSource(id) {
			const ok = repo.removeSource(id);
			if (ok) cached = null;
			return ok;
		},
		status() {
			const t = now();
			const cal = calendar();
			return {
				coveredUntil: MARKET_EVENTS.map((type) => ({
					type,
					until:
						cal.covered[type].find((r) => r.from <= t && t < r.until)?.until ??
						null,
				})),
				lastRunAt,
				nextRunAt: nextRunAt(),
			};
		},
		calendar,
		tick() {
			if (running) return;
			const next = nextRunAt();
			// 足したか変えたばかりの取得元は、次の取得を待たずに取りに行く
			const fresh = repo
				.listSources()
				.some((s) => s.lastSuccessAt === null && s.lastError === null);
			if (next === null || now() >= next || fresh) void service.run();
		},
		run() {
			if (!running) {
				running = runOnce()
					.catch((e) => console.error("calendar: fetch failed", e))
					.finally(() => {
						running = null;
					});
			}
			return running;
		},
	};
	return service;
}
