import { describe, expect, test } from "bun:test";
import {
	EVENT_CALENDAR_RANGE,
	eventSpanText,
	eventsBetween,
	jstDate,
	jstDateTime,
	MARKET_EVENTS,
	nextEvent,
	SCHEDULED_EVENTS,
} from "./event-calendar";

describe("暦のデータ", () => {
	test("時刻の順で、どれも暦の期間の中にある", () => {
		const starts = SCHEDULED_EVENTS.map((e) => e.start);
		expect(starts).toEqual([...starts].sort((a, b) => a - b));
		for (const e of SCHEDULED_EVENTS) {
			expect(e.start).toBeGreaterThanOrEqual(EVENT_CALENDAR_RANGE.from);
			expect(e.end).toBeLessThan(EVENT_CALENDAR_RANGE.until);
		}
	});

	test("米国の発表は ET の夏時間を反映し、日銀会合は JST の日の 0:00 から24時間", () => {
		const at = (iso: string) =>
			SCHEDULED_EVENTS.find((e) => e.start === Date.parse(iso));
		// 冬時間（-05:00）と夏時間（-04:00）の FOMC 声明
		expect(at("2026-01-28T19:00:00Z")?.type).toBe("fomc");
		expect(at("2026-06-17T18:00:00Z")?.type).toBe("fomc");
		const boj = at("2026-06-15T15:00:00Z");
		expect(boj?.type).toBe("boj");
		expect(boj && boj.end - boj.start).toBe(24 * 3_600_000);
	});

	test("どの種類も毎年ある", () => {
		for (const type of MARKET_EVENTS) {
			for (const y of [2022, 2023, 2024, 2025, 2026]) {
				const from = Date.parse(`${y}-01-01T00:00:00+09:00`);
				const to = Date.parse(`${y + 1}-01-01T00:00:00+09:00`) - 1;
				expect(eventsBetween([type], from, to).length).toBeGreaterThan(0);
			}
		}
	});
});

describe("暦の読み出し", () => {
	const t = Date.parse("2026-09-11T12:30:00Z");
	test("範囲の端に掛かるイベントも返し、種類で絞る", () => {
		expect(eventsBetween(["cpi"], t, t + 1)).toHaveLength(1);
		expect(eventsBetween(["nfp"], t, t + 1)).toHaveLength(0);
		expect(nextEvent(["cpi"], t)?.start).toBe(
			Date.parse("2026-10-14T12:30:00Z"),
		);
		expect(nextEvent(["cpi"], Date.parse("2026-12-31T00:00:00Z"))).toBeNull();
	});

	test("文言", () => {
		expect(eventSpanText(0, 24)).toBe("後 24 時間");
		expect(eventSpanText(2, 0)).toBe("前 2 時間");
		expect(eventSpanText(0, 0)).toBe("発表の時刻");
		expect(jstDate(EVENT_CALENDAR_RANGE.until - 1)).toBe("2026-12-31");
		expect(jstDateTime(t)).toBe("9/11 21:30");
	});
});
