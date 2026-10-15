import { describe, expect, test } from "bun:test";
import { parseEventSourceInput, toCalendar } from "./calendar-domain";

const H = 3_600_000;
const T = Date.parse("2026-10-14T00:00:00Z");

describe("toCalendar", () => {
	const items = [
		{ summary: "⁂ US CPI m/m", start: T + 12 * H, allDay: false },
		{ summary: "⁂ US CPI y/y", start: T + 12 * H, allDay: false },
		{ summary: "⁂ US Core CPI m/m", start: T + 12 * H, allDay: false },
		{ summary: "BOJ Policy Rate", start: T + 30 * H, allDay: false },
		{ summary: "Bank Holiday", start: T - 48 * H, allDay: true },
	];

	test("語に当たる予定だけを、大文字小文字を区別せず拾う。日銀会合は JST の日の 0:00〜24:00 にする", () => {
		const c = toCalendar(items, { cpi: "us cpi m/m", boj: "BOJ" }, T, null);
		expect(c.types).toEqual(["cpi", "boj"]);
		const bojDay = Date.parse("2026-10-15T00:00:00+09:00");
		expect(c.events).toEqual([
			{ type: "cpi", start: T + 12 * H, end: T + 12 * H },
			{ type: "boj", start: bojDay, end: bojDay + 24 * H },
		]);
	});

	test("そろっている期間は載っている最初の予定から最後の予定まで。取得した時刻がその外なら時刻まで広げる", () => {
		expect(toCalendar(items, { cpi: "CPI" }, T, null).range).toEqual({
			from: T - 48 * H,
			until: T + 30 * H + 1,
		});
		expect(toCalendar(items, { cpi: "CPI" }, T + 40 * H, null).range).toEqual({
			from: T - 48 * H,
			until: T + 40 * H + 1,
		});
	});

	test("置き換えるのは、載っている予定の範囲と取得した時刻から後", () => {
		expect(toCalendar(items, { cpi: "CPI" }, T + 40 * H, null).listed).toEqual({
			from: T - 48 * H,
			until: T + 30 * H + 1,
		});
		expect(
			toCalendar(items.slice(0, 4), { cpi: "CPI" }, T, null).listed,
		).toEqual({
			from: T,
			until: T + 30 * H + 1,
		});
	});

	test("前回の取得が1日以内なら、その時刻からそろっているとみなす", () => {
		const prev = T - 50 * H;
		expect(
			toCalendar(items, { cpi: "CPI" }, prev + 24 * H, prev).range.from,
		).toBe(prev);
		expect(
			toCalendar(items, { cpi: "CPI" }, prev + 24 * H + 1, prev).range.from,
		).toBe(T - 48 * H);
	});
});

describe("parseEventSourceInput", () => {
	test("知らない種類や文字列でない語は形が違う", () => {
		expect(
			parseEventSourceInput({
				name: "a",
				url: "https://x",
				keywords: { cpi: "CPI" },
			}),
		).toEqual({ name: "a", url: "https://x", keywords: { cpi: "CPI" } });
		expect(
			parseEventSourceInput({
				name: "a",
				url: "https://x",
				keywords: { x: "CPI" },
			}),
		).toBeNull();
		expect(
			parseEventSourceInput({
				name: "a",
				url: "https://x",
				keywords: { cpi: 1 },
			}),
		).toBeNull();
		expect(parseEventSourceInput({ name: "a", url: "https://x" })).toBeNull();
	});
});
