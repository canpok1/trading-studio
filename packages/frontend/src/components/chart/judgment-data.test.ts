import { describe, expect, test } from "bun:test";
import { alignJudgments, judgmentRuns, stripJudges } from "./judgment-data";

describe("alignJudgments", () => {
	test("足の開始時刻で判定の並びを引き、範囲外や欠けた足は null", () => {
		const r = alignJudgments(
			{
				from: 100,
				step: 10,
				firstScoredAt: 0,
				values: {
					trend: ["up", null, "down"],
					risk: ["normal", "normal", "crisis"],
					sentiment: ["0", "+1", "-2"],
				},
			},
			// 110 の足は欠けている。90 と 130 は並びの範囲外
			[90, 100, 120, 130],
		);
		expect(r?.trend).toEqual([null, "up", "down", null]);
		expect(r?.risk).toEqual([null, "normal", "crisis", null]);
		expect(r?.sentiment).toEqual([null, "0", "-2", null]);
	});
});

test("どの足にも判定が無ければ null", () => {
	const r = alignJudgments(
		{
			from: 100,
			step: 10,
			firstScoredAt: null,
			values: { trend: [null], risk: [null], sentiment: [null] },
		},
		[100],
	);
	expect(r).toBeNull();
});

describe("judgmentRuns", () => {
	test("同じ値の連続をまとめ、null で区切る", () => {
		expect(judgmentRuns(["a", "a", null, "a", "b", "b"])).toEqual([
			{ from: 0, to: 1, value: "a" },
			{ from: 3, to: 3, value: "a" },
			{ from: 4, to: 5, value: "b" },
		]);
		expect(judgmentRuns([null, null])).toEqual([]);
	});
});

test("帯は背景以外の判定", () => {
	expect(stripJudges("risk")).toEqual(["trend", "sentiment"]);
});
