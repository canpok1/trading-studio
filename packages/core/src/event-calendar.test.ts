import { describe, expect, test } from "bun:test";
import type { EventCalendar } from "./event-calendar";
import {
	atLeast,
	calendarGap,
	eventSpanText,
	eventsBetween,
	importanceText,
	jstDate,
	jstDateTime,
	mergeRanges,
	nextEvent,
} from "./event-calendar";

const H = 3_600_000;
const t = Date.parse("2026-09-11T12:30:00Z");
const cal: EventCalendar = {
	events: [
		{ title: "US CPI", start: t, end: t, importance: "high" },
		{ title: "US PPI", start: t + H, end: t + H, importance: "medium" },
		{ title: "AU GDP", start: t + 2 * H, end: t + 2 * H, importance: null },
		{
			title: "US CPI",
			start: t + 800 * H,
			end: t + 800 * H,
			importance: "high",
		},
	],
	covered: [
		{ from: t - 100 * H, until: t + 10 * H },
		{ from: t + 20 * H, until: t + 1000 * H },
	],
};

describe("重要度", () => {
	test("下限以上か", () => {
		expect(atLeast("high", "medium")).toBe(true);
		expect(atLeast("medium", "medium")).toBe(true);
		expect(atLeast("low", "medium")).toBe(false);
	});

	test("文言", () => {
		expect(importanceText("high")).toBe("重要度 高");
		expect(importanceText("medium")).toBe("重要度 中以上");
		expect(importanceText("low")).toBe("すべての予定");
	});
});

describe("暦の読み出し", () => {
	test("範囲の端に掛かる予定も返し、重要度の下限で絞る。未判断の予定は返さない", () => {
		expect(eventsBetween(cal, "high", t, t + 2 * H)).toHaveLength(1);
		expect(eventsBetween(cal, "medium", t + 1, t + 2 * H)).toHaveLength(1);
		expect(eventsBetween(cal, "low", t + 1, t + 2 * H)).toHaveLength(1);
		expect(nextEvent(cal, "high", t)?.start).toBe(t + 800 * H);
		expect(nextEvent(cal, "medium", t)?.start).toBe(t + H);
		expect(nextEvent(cal, "high", t + 800 * H)).toBeNull();
	});

	test("文言", () => {
		expect(eventSpanText(0, 24)).toBe("後 24 時間");
		expect(eventSpanText(2, 0)).toBe("前 2 時間");
		expect(eventSpanText(0, 0)).toBe("発表の時刻");
		expect(jstDate(Date.parse("2026-12-31T14:59:59Z"))).toBe("2026-12-31");
		expect(jstDateTime(t)).toBe("9/11 21:30");
	});
});

describe("暦の期間", () => {
	const r = (from: number, until: number) => ({ from, until });
	test("重なるか接する期間をまとめ、空の期間は捨てる", () => {
		expect(
			mergeRanges([r(5, 8), r(0, 3), r(3, 4), r(7, 10), r(20, 20)]),
		).toEqual([r(0, 4), r(5, 10)]);
	});

	test("暦切れの理由は、期間の外に掛かるか、重要度が未判断の予定に掛かること", () => {
		expect(calendarGap(cal, t - H, t + H)).toBeNull();
		expect(calendarGap(cal, t, t + 10 * H)).toBe("暦は 2026-09-12 7:30 まで");
		expect(calendarGap(cal, t + 15 * H, t + 25 * H)).toBe(
			"暦は 2026-09-12 17:30 から",
		);
		expect(calendarGap(cal, t + 2000 * H, t + 2001 * H)).toBe(
			"暦は 2026-10-23 13:30 まで",
		);
		expect(calendarGap({ events: [], covered: [] }, t, t)).toBe("暦が無い");
		expect(calendarGap(cal, t + H, t + 3 * H)).toBe(
			"「AU GDP」の重要度が未判断",
		);
	});
});
