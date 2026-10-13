import { describe, expect, test } from "bun:test";
import {
	buildAdvicePrompt,
	extractAdviceJson,
	parseAdviceResponse,
} from "./prompt-domain";

describe("応答の検証", () => {
	test("見出しがそろっていれば受け付け、欠けていれば理由を投げる", () => {
		const ok = { analysis: " a ", good: "b", bad: "c", improvements: "d" };
		expect(parseAdviceResponse(ok)).toEqual({
			analysis: "a",
			good: "b",
			bad: "c",
			improvements: "d",
		});
		expect(() => parseAdviceResponse({ ...ok, bad: "" })).toThrow("bad");
		expect(() => parseAdviceResponse(null)).toThrow();
	});

	test("貼った答えは囲みや前後の説明文があっても JSON を取り出す", () => {
		expect(
			extractAdviceJson('はい。\n```json\n{"a": {"b": 1}}\n```\n以上です'),
		).toEqual({ a: { b: 1 } });
		expect(() => extractAdviceJson("JSON なし")).toThrow("JSON が無い");
		expect(() => extractAdviceJson("{壊れた}")).toThrow("読めない");
	});

	test("差し込む値に差し込み口の文字があっても二重に置き換えない", () => {
		const p = buildAdvicePrompt("{instructions}", "指示");
		expect(p).toContain("<backtest>\n{instructions}\n</backtest>");
	});
});
