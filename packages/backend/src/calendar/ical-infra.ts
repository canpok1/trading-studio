// iCal（RFC 5545）から予定を読む。依存を増やさないため、予定（VEVENT）の件名と開始時刻だけを読む

import type { FetchIcal } from "./calendar-domain";
import type { IcalEvent } from "./repository-domain";

/** 折り返された行（空白で始まる行）を前の行へつなぐ */
function unfold(text: string): string[] {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/\n[ \t]/g, "")
		.split("\n");
}

function unescapeText(v: string): string {
	return v.replace(/\\([nN,;\\])/g, (_, c: string) =>
		c === "n" || c === "N" ? " " : c,
	);
}

/** 時差の名前（America/New_York など）の、その時刻の UTC からのずれ（ミリ秒） */
function offsetMs(tz: string, utc: number): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(new Date(utc));
	const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
	const local = Date.UTC(
		n("year"),
		n("month") - 1,
		n("day"),
		n("hour"),
		n("minute"),
		n("second"),
	);
	return local - utc;
}

/** 時差 tz の壁時計の時刻を UTC にする。夏時間の切り替わりでずれが変わる場合に備えて2回求める */
function zonedToUtc(wall: number, tz: string): number {
	let utc = wall - offsetMs(tz, wall);
	utc = wall - offsetMs(tz, utc);
	return utc;
}

/** DTSTART の値を読む。読めなければ null */
function parseStart(
	params: string,
	value: string,
	defaultTz: string | null,
): { start: number; allDay: boolean } | null {
	const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
	const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
	const tz = /(?:^|;)TZID=("?)([^";:]+)\1/i.exec(params)?.[2] ?? defaultTz;
	const wallOf = (m: RegExpExecArray, time: boolean) =>
		Date.UTC(
			Number(m[1]),
			Number(m[2]) - 1,
			Number(m[3]),
			time ? Number(m[4]) : 0,
			time ? Number(m[5]) : 0,
			time ? Number(m[6]) : 0,
		);
	try {
		if (date) {
			const wall = wallOf(date, false);
			return { start: tz ? zonedToUtc(wall, tz) : wall, allDay: true };
		}
		if (dt) {
			const wall = wallOf(dt, true);
			if (dt[7] === "Z" || !tz) return { start: wall, allDay: false };
			return { start: zonedToUtc(wall, tz), allDay: false };
		}
	} catch {
		// 知らない時差の名前
		return null;
	}
	return null;
}

/** iCal の本文から予定を読む。iCal でなければ例外 */
export function parseIcal(text: string): IcalEvent[] {
	const lines = unfold(text);
	if (!lines.some((l) => /^BEGIN:VCALENDAR$/i.test(l.trim()))) {
		throw new Error("iCal として読めない");
	}
	const calTz =
		lines
			.find((l) => /^X-WR-TIMEZONE[;:]/i.test(l))
			?.replace(/^[^:]*:/, "")
			.trim() || null;
	const out: IcalEvent[] = [];
	let cur: { summary: string | null; start: IcalEvent | null } | null = null;
	let depth = 0;
	for (const raw of lines) {
		const line = raw.trimEnd();
		if (/^BEGIN:VEVENT$/i.test(line)) {
			cur = { summary: null, start: null };
			depth = 0;
			continue;
		}
		if (!cur) continue;
		// 予定の中の VALARM などの値は読まない
		if (/^BEGIN:/i.test(line)) depth++;
		else if (/^END:VEVENT$/i.test(line)) {
			if (cur.summary !== null && cur.start) {
				out.push({ ...cur.start, summary: cur.summary });
			}
			cur = null;
		} else if (/^END:/i.test(line)) depth--;
		else if (depth === 0) {
			const m = /^([A-Z-]+)((?:;[^:]*)?):(.*)$/i.exec(line);
			if (!m) continue;
			const name = (m[1] as string).toUpperCase();
			if (name === "SUMMARY") cur.summary = unescapeText(m[3] as string).trim();
			if (name === "DTSTART") {
				const s = parseStart(m[2] as string, (m[3] as string).trim(), calTz);
				if (s) cur.start = { ...s, summary: "" };
			}
		}
	}
	return out;
}

/** 本文を取る手段 fetchText で iCal を取り、予定にする */
export const icalFeed =
	(fetchText: (url: string) => Promise<string>): FetchIcal =>
	async (url) =>
		parseIcal(await fetchText(url));
