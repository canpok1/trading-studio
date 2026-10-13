import { describe, expect, test } from "bun:test";
import {
	formatDate,
	formatDateTime,
	formatDateWeekday,
	formatDateWeekdayTime,
	formatVersion,
	fromDateInputValue,
	toDateInputValue,
} from "./format";

describe("日時の表示", () => {
	// 2026-09-26 04:14:15 UTC = 13:14:15 JST
	const t = Date.UTC(2026, 8, 26, 4, 14, 15);

	test("JST の 2026/09/26 13:14:15 の形", () => {
		expect(formatDateTime(t)).toBe("2026/09/26 13:14:15");
	});

	test("バージョンは Ver 2026-09-26 13:14 の形。無ければ指定の文言", () => {
		expect(formatVersion(t, "開発版")).toBe("Ver 2026-09-26 13:14");
		expect(formatVersion(null, "記録なし")).toBe("Ver 記録なし");
	});

	test("日付だけなら 2026/09/26", () => {
		expect(formatDate(t)).toBe("2026/09/26");
	});

	test("UTC で前日でも JST の日付で出す", () => {
		// 2026-09-25 15:00 UTC = 2026-09-26 00:00 JST
		expect(formatDate(Date.UTC(2026, 8, 25, 15))).toBe("2026/09/26");
		expect(formatDateWeekday(Date.UTC(2026, 8, 25, 15))).toBe(
			"2026/09/26（土）",
		);
		expect(formatDateWeekdayTime(Date.UTC(2026, 8, 25, 15, 4))).toBe(
			"2026/09/26（土） 00:04",
		);
	});

	test("日付の入力値と JST 0:00 を行き来できる", () => {
		const ms = fromDateInputValue("2026-09-26");
		expect(ms).toBe(Date.UTC(2026, 8, 25, 15));
		expect(toDateInputValue(ms as number)).toBe("2026-09-26");
		expect(fromDateInputValue("2026/09/26")).toBeNull();
	});
});
