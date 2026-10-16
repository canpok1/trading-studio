import { describe, expect, test } from "bun:test";
import { parseEventSourceInput, toCalendar } from "./calendar-domain";

const H = 3_600_000;
const T = Date.parse("2026-10-14T00:00:00Z");

const item = (
	summary: string,
	start: number,
	allDay = false,
	uid?: string,
) => ({
	uid: uid ?? null,
	summary,
	description: null,
	start,
	allDay,
});

describe("toCalendar", () => {
	const items = [
		item("⁂ US CPI m/m", T + 12 * H, false, "1"),
		item("⁂ US Core CPI m/m", T + 12 * H),
		item("BOJ Policy Rate", T + 30 * H, false, "3"),
		item("Bank Holiday", T - 48 * H, true, "4"),
	];

	test("すべての予定を保存する形にし、UID の無い予定は件名と時刻で見分ける。終日の予定はその日の 24 時間", () => {
		expect(toCalendar(items, T, null).events).toEqual([
			{
				uid: "1",
				title: "⁂ US CPI m/m",
				description: null,
				start: T + 12 * H,
				end: T + 12 * H,
				allDay: false,
			},
			{
				uid: `⁂ US Core CPI m/m@${T + 12 * H}`,
				title: "⁂ US Core CPI m/m",
				description: null,
				start: T + 12 * H,
				end: T + 12 * H,
				allDay: false,
			},
			{
				uid: "3",
				title: "BOJ Policy Rate",
				description: null,
				start: T + 30 * H,
				end: T + 30 * H,
				allDay: false,
			},
			{
				uid: "4",
				title: "Bank Holiday",
				description: null,
				start: T - 48 * H,
				end: T - 24 * H,
				allDay: true,
			},
		]);
	});

	test("そろっている期間は載っている最初の予定から、最後の予定か次の取得の予定時刻の遅いほうまで", () => {
		expect(toCalendar(items, T, null).range).toEqual({
			from: T - 48 * H,
			until: T + 30 * H + 1,
		});
		expect(toCalendar(items, T + 40 * H, null).range).toEqual({
			from: T - 48 * H,
			until: T + 46 * H,
		});
	});

	test("取得した時刻から 7 日より前・366 日より後の予定は、そろっている期間に数えない", () => {
		const far = [
			...items,
			item("誕生日", T - 400 * 24 * H, true),
			item("遠い先", T + 800 * 24 * H, true),
		];
		expect(toCalendar(far, T, null).range).toEqual({
			from: T - 48 * H,
			until: T + 30 * H + 1,
		});
	});

	test("置き換えるのは、取得した時刻から載っている最後の予定まで", () => {
		expect(toCalendar(items, T, null).listed).toEqual({
			from: T,
			until: T + 30 * H + 1,
		});
	});

	test("前回の取得が1日以内なら、その時刻からそろっているとみなす", () => {
		const prev = T - 50 * H;
		expect(toCalendar(items, prev + 24 * H, prev).range.from).toBe(prev);
		expect(toCalendar(items, prev + 24 * H + 1, prev).range.from).toBe(
			T - 48 * H,
		);
	});
});

describe("parseEventSourceInput", () => {
	test("名前と URL が文字列でなければ形が違う", () => {
		expect(parseEventSourceInput({ name: "a", url: "https://x" })).toEqual({
			name: "a",
			url: "https://x",
		});
		expect(parseEventSourceInput({ name: "a", url: 1 })).toBeNull();
		expect(parseEventSourceInput(null)).toBeNull();
	});
});
