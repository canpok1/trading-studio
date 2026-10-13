import { describe, expect, test } from "bun:test";
import { jst, parseTime } from "./views-domain";

const START = Date.UTC(2026, 6, 31, 15);

describe("parseTime", () => {
	test("日付だけは JST の 0:00、日時はタイムゾーン付きだけ読む", () => {
		expect(parseTime("2026-08-01")).toBe(START);
		expect(parseTime("2026-08-01T00:00:00+09:00")).toBe(START);
		expect(parseTime("2026-07-31T15:00:00Z")).toBe(START);
		expect(parseTime("2026-08-01T00:00:00")).toBeNull();
		expect(parseTime("あした")).toBeNull();
	});
	test("出力は JST の ISO 8601", () => {
		expect(jst(START)).toBe("2026-08-01T00:00:00+09:00");
		expect(jst(START + 123)).toBe("2026-08-01T00:00:00.123+09:00");
	});
});
