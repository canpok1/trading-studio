import { describe, expect, test } from "bun:test";
import { buildEventPrompt, parseEventResponse } from "./prompt-domain";

const T0 = Date.UTC(2026, 9, 14, 12, 30);
const event = {
	sourceName: "FF",
	title: "US CPI {criteria}",
	description: "Impact: High",
	start: T0,
	allDay: false,
};

describe("予定のプロンプト", () => {
	test("予定 → 評価基準 → 依頼の順に差し込み、時刻は JST で書く", () => {
		const p = buildEventPrompt(event, "基準");
		expect(p.indexOf("<event>")).toBeLessThan(p.indexOf("<criteria>"));
		expect(p.indexOf("<criteria>")).toBeLessThan(p.indexOf("# 依頼"));
		expect(p).toContain("日時: 2026-10-14 21:30 JST");
		// 差し込んだ値の中の {criteria} は置き換えない
		expect(p).toContain("件名: US CPI {criteria}");
		expect(p).toContain("説明: Impact: High");
	});

	test("終日の予定は日付だけ、説明が無ければ説明の行を出さない、長い説明は 500 文字まで", () => {
		const day = Date.UTC(2026, 9, 13, 15);
		const p = buildEventPrompt(
			{ ...event, start: day, allDay: true, description: null },
			"基準",
		);
		expect(p).toContain("日時: 2026-10-14（終日）");
		expect(p).not.toContain("説明:");
		const long = buildEventPrompt(
			{ ...event, description: "a".repeat(600) },
			"基準",
		);
		expect(long).toContain(`説明: ${"a".repeat(500)}\n`);
	});
});

describe("予定の応答", () => {
	test("重要度と理由を受け取る", () => {
		expect(
			parseEventResponse({ importance: "high", reason: " 理由 " }),
		).toEqual({ importance: "high", reason: "理由" });
	});

	test("形が違えば理由の文字列を返す", () => {
		expect(typeof parseEventResponse([])).toBe("string");
		expect(parseEventResponse({ importance: "huge", reason: "x" })).toContain(
			"importance",
		);
		expect(parseEventResponse({ importance: "low", reason: "" })).toBe(
			"reason が空",
		);
	});
});
