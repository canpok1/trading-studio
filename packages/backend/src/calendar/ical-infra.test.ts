import { describe, expect, test } from "bun:test";
import { parseIcal } from "./ical-infra";

const cal = (body: string, head = "") =>
	`BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${head}${body}END:VCALENDAR\r\n`;

describe("parseIcal", () => {
	test("時差の名前つきの時刻は夏時間を反映して UTC にし、折り返した行をつなぎ、通知の中は読まない", () => {
		// Forex Factory の週次の形（2026-10 に取得したものを縮めた）
		const events = parseIcal(
			cal(
				[
					"BEGIN:VEVENT",
					"UID:1",
					"SUMMARY:⁂ US CPI m/m",
					"DESCRIPTION:Impact: High\\n\\nView Event: https://www.forexfactory.com/calend",
					" ar/1",
					"DTSTART;TZID=America/New_York:20261014T083000",
					"BEGIN:VALARM",
					"ACTION:AUDIO",
					"SUMMARY:通知",
					"TRIGGER:-PT10M",
					"END:VALARM",
					"END:VEVENT",
					"BEGIN:VEVENT",
					"SUMMARY:⁂ US Non-Farm Employment C",
					" hange",
					"DTSTART;TZID=America/New_York:20261204T083000",
					"END:VEVENT",
					"",
				].join("\r\n"),
			),
		);
		expect(events).toEqual([
			// 夏時間（-04:00）
			{
				uid: "1",
				summary: "⁂ US CPI m/m",
				description:
					"Impact: High  View Event: https://www.forexfactory.com/calendar/1",
				start: Date.parse("2026-10-14T12:30:00Z"),
				allDay: false,
			},
			// 冬時間（-05:00）
			{
				uid: null,
				summary: "⁂ US Non-Farm Employment Change",
				description: null,
				start: Date.parse("2026-12-04T13:30:00Z"),
				allDay: false,
			},
		]);
	});

	test("UTC の時刻・終日の予定・暦の既定の時差・エスケープ。取り消した予定は捨てる", () => {
		const events = parseIcal(
			cal(
				[
					"BEGIN:VEVENT",
					"SUMMARY:FOMC\\, statement",
					"DTSTART:20261028T180000Z",
					"END:VEVENT",
					"BEGIN:VEVENT",
					"SUMMARY:日銀会合",
					"DTSTART;VALUE=DATE:20261030",
					"END:VEVENT",
					"BEGIN:VEVENT",
					"SUMMARY:時刻だけ",
					"DTSTART:20261030T090000",
					"END:VEVENT",
					"BEGIN:VEVENT",
					"SUMMARY:開始の無い予定",
					"END:VEVENT",
					"BEGIN:VEVENT",
					"SUMMARY:取り消した予定",
					"STATUS:CANCELLED",
					"DTSTART:20261031T090000Z",
					"END:VEVENT",
					"",
				].join("\n"),
				"X-WR-TIMEZONE:Asia/Tokyo\n",
			),
		);
		expect(events).toEqual([
			{
				uid: null,
				summary: "FOMC, statement",
				description: null,
				start: Date.parse("2026-10-28T18:00:00Z"),
				allDay: false,
			},
			{
				// 日付だけの値は、暦の既定の時差に依らず JST のその日の 0:00
				uid: null,
				summary: "日銀会合",
				description: null,
				start: Date.parse("2026-10-30T00:00:00+09:00"),
				allDay: true,
			},
			{
				uid: null,
				summary: "時刻だけ",
				description: null,
				start: Date.parse("2026-10-30T09:00:00+09:00"),
				allDay: false,
			},
		]);
	});

	test("知らない時差の名前の予定は捨て、iCal でなければ例外", () => {
		expect(
			parseIcal(
				cal(
					"BEGIN:VEVENT\nSUMMARY:x\nDTSTART;TZID=Nowhere/City:20261030T090000\nEND:VEVENT\n",
				),
			),
		).toEqual([]);
		expect(() => parseIcal("<html></html>")).toThrow("iCal として読めない");
	});
});
