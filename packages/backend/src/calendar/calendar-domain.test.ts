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

	test("そろっている期間は載っている最初の予定から、最後の予定か次の取得の予定時刻の遅いほうまで", () => {
		expect(toCalendar(items, { cpi: "CPI" }, T, null).range).toEqual({
			from: T - 48 * H,
			until: T + 30 * H + 1,
		});
		expect(toCalendar(items, { cpi: "CPI" }, T + 40 * H, null).range).toEqual({
			from: T - 48 * H,
			until: T + 46 * H,
		});
	});

	test("取得した時刻から 7 日より前・366 日より後の予定は、そろっている期間に数えない", () => {
		const far = [
			...items,
			{ summary: "誕生日", start: T - 400 * 24 * H, allDay: true },
			{ summary: "遠い先", start: T + 800 * 24 * H, allDay: true },
		];
		expect(toCalendar(far, { cpi: "CPI" }, T, null).range).toEqual({
			from: T - 48 * H,
			until: T + 30 * H + 1,
		});
	});

	test("日銀会合以外の終日の予定は、その日の 24 時間をイベントの時間にする", () => {
		const day = [{ summary: "FOMC", start: T, allDay: true }];
		expect(toCalendar(day, { fomc: "FOMC" }, T, null).events).toEqual([
			{ type: "fomc", start: T, end: T + 24 * H },
		]);
	});

	test("置き換えるのは、載っている予定（取得した時刻からを含む）の範囲。日の 0:00 にずらした日銀会合も含める", () => {
		expect(
			toCalendar(items.slice(0, 4), { cpi: "CPI" }, T, null).listed,
		).toEqual({ from: T, until: T + 30 * H + 1 });
		// 日銀会合の当日（JST 10/15 0:00 = T + 15 時間）の後に取得しても、保存した日銀会合を置き換える
		const boj = toCalendar(items.slice(3, 4), { boj: "BOJ" }, T + 20 * H, null);
		expect(boj.listed.from).toBe(T + 15 * H);
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
