// 予定（経済指標の発表・金融政策の会合など）の暦。買いの条件「予定の前後でない」に使う。
// 予定は取得元の iCal とアプリが持つ過去の分から作り、重要度は AI が判断する（docs/adr/0029-event-calendar-from-ical.md）

import { JST_OFFSET_MS } from "./timeframe";

/** 予定の重要度。高い順 */
export const EVENT_IMPORTANCES = ["high", "medium", "low"] as const;
export type EventImportance = (typeof EVENT_IMPORTANCES)[number];

export const EVENT_IMPORTANCE_LABELS: Record<EventImportance, string> = {
	high: "高",
	medium: "中",
	low: "低",
};

export function isEventImportance(v: unknown): v is EventImportance {
	return (EVENT_IMPORTANCES as readonly unknown[]).includes(v);
}

/** importance が min 以上か */
export function atLeast(importance: EventImportance, min: EventImportance) {
	return (
		EVENT_IMPORTANCES.indexOf(importance) <= EVENT_IMPORTANCES.indexOf(min)
	);
}

/** 重要度の下限の文言。例: 「重要度 高」「重要度 中以上」「すべての予定」 */
export function importanceText(min: EventImportance): string {
	if (min === "high") return "重要度 高";
	if (min === "low") return "すべての予定";
	return `重要度 ${EVENT_IMPORTANCE_LABELS[min]}以上`;
}

/**
 * 予定1件。end は時間の幅を持つもの（終日の予定はその日の 24 時間）だけ start と違う。
 * importance は判断に使う版での重要度。まだ判断していないか判断に失敗していれば null
 */
export type ScheduledEvent = {
	title: string;
	start: number;
	end: number;
	importance: EventImportance | null;
};

export const HOUR_MS = 3_600_000;

/** JST の年月日。例: 「2026-12-31」 */
export function jstDate(t: number): string {
	return new Date(t + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** JST の月日と時刻。例: 「10/29 3:00」 */
export function jstDateTime(t: number): string {
	const d = new Date(t + JST_OFFSET_MS);
	const mm = String(d.getUTCMinutes()).padStart(2, "0");
	return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${mm}`;
}

/** 暦が全件を持っている期間。from 以上 until 未満 */
export type CalendarRange = { from: number; until: number };

/**
 * 判定に使う暦。covered は全件を持っている期間（重ならず時刻の順）。
 * この外を含む判定は、予定が無いと言えない
 */
export type EventCalendar = {
	/** 時刻の順 */
	events: readonly ScheduledEvent[];
	covered: readonly CalendarRange[];
};

/** 重なるか接する期間をまとめる（時刻の順） */
export function mergeRanges(ranges: readonly CalendarRange[]): CalendarRange[] {
	const out: CalendarRange[] = [];
	for (const r of [...ranges].sort((a, b) => a.from - b.from)) {
		if (r.until <= r.from) continue;
		const last = out.at(-1);
		if (last && r.from <= last.until)
			last.until = Math.max(last.until, r.until);
		else out.push({ ...r });
	}
	return out;
}

/** JST の年月日と時刻。例: 「2026-12-31 23:00」 */
export function jstDateTimeFull(t: number): string {
	const d = new Date(t + JST_OFFSET_MS);
	const mm = String(d.getUTCMinutes()).padStart(2, "0");
	return `${jstDate(t)} ${d.getUTCHours()}:${mm}`;
}

/** 予定の時間 [start, end] が [from, to] に掛かるか */
const covers = (e: ScheduledEvent, from: number, to: number) =>
	e.start <= to && e.end >= from;

/**
 * [from, to] の暦がそろっていなければ、その理由（暦切れ）。そろっていれば null。
 * 期間の外に掛かるか、重要度をまだ判断していない予定があれば、そろっていない。
 * 例: 「暦は 2027-01-01 0:00 まで」「「US CPI m/m」の重要度が未判断」
 */
export function calendarGap(
	cal: EventCalendar,
	from: number,
	to: number,
): string | null {
	const ranges = cal.covered;
	if (!ranges.some((r) => r.from <= from && to < r.until)) {
		// 判定の期間の始まりを含む期間か、無ければその次・その前の期間で書く
		const around = ranges.find((r) => r.from <= from && from < r.until);
		if (around) return `暦は ${jstDateTimeFull(around.until)} まで`;
		const after = ranges.find((r) => r.from > from);
		if (after) return `暦は ${jstDateTimeFull(after.from)} から`;
		const before = ranges.at(-1);
		return before ? `暦は ${jstDateTimeFull(before.until)} まで` : "暦が無い";
	}
	const unjudged = cal.events.find(
		(e) => e.importance === null && covers(e, from, to),
	);
	return unjudged ? `「${unjudged.title}」の重要度が未判断` : null;
}

/** [from, to] に掛かる、重要度が min 以上の予定（時刻の順） */
export function eventsBetween(
	cal: EventCalendar,
	min: EventImportance,
	from: number,
	to: number,
): ScheduledEvent[] {
	return cal.events.filter(
		(e) =>
			e.importance !== null &&
			atLeast(e.importance, min) &&
			covers(e, from, to),
	);
}

/** t より後に始まる、重要度が min 以上の最初の予定。暦に無ければ null */
export function nextEvent(
	cal: EventCalendar,
	min: EventImportance,
	t: number,
): ScheduledEvent | null {
	return (
		cal.events.find(
			(e) => e.importance !== null && atLeast(e.importance, min) && e.start > t,
		) ?? null
	);
}

/** 予定の前後の時間の文言。例: 「前 2 時間・後 24 時間」、どちらも 0 なら「発表の時刻」 */
export function eventSpanText(beforeHours: number, afterHours: number): string {
	const parts = [
		beforeHours > 0 ? `前 ${beforeHours} 時間` : "",
		afterHours > 0 ? `後 ${afterHours} 時間` : "",
	].filter(Boolean);
	return parts.length > 0 ? parts.join("・") : "発表の時刻";
}
