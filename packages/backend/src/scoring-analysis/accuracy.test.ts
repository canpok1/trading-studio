import { describe, expect, test } from "bun:test";
import { DEFAULT_AGGREGATION_RULE } from "@trading-studio/core";
import { articlePrecision, moveLevel, roughLevel } from "./accuracy";

const BANDS = {
	sentiment: { small: 0.5, large: 2 },
	risk: { slight: 1, rough: 2, heavy: 3, wild: 5 },
};

describe("値動きの段階", () => {
	test("センチメントと比べる5段階は、境目ちょうどを上の段階に入れる", () => {
		expect(
			[-2, -1.9, -0.5, -0.4, 0, 0.49, 0.5, 1.99, 2].map((p) =>
				moveLevel(p, BANDS.sentiment),
			),
		).toEqual([-2, -1, -1, 0, 0, 0, 1, 1, 2]);
	});
	test("リスクと比べる5段階は、上下を問わず大きさで分ける", () => {
		expect(
			[0, 0.99, -1, 1.99, 2, -2.5, 3, -4.9, 5, -8].map((p) =>
				roughLevel(p, BANDS.risk),
			),
		).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
	});
});

describe("articlePrecision", () => {
	const of = (sentiment: number, risk: number, ret: number) =>
		articlePrecision({ sentiment, risk }, ret, DEFAULT_AGGREGATION_RULE, BANDS);

	test("センチメントは評価と値動きの段階が一致で 5、1段ずれるごとに 1 下げる", () => {
		// かなり強気（+2）
		expect([3, 1, 0, -1, -3].map((r) => of(80, 0, r).sentiment)).toEqual([
			5, 4, 3, 2, 1,
		]);
		// 中立（0）で横ばい
		expect(of(0, 0, 0.1).sentiment).toBe(5);
	});

	test("リスクは 平常＝静か・警戒＝荒れた・危機＝大荒れ に当て、ずれた段数で下げる", () => {
		// 平常（0点）
		expect([0, 1.5, 2.5, 4, 6].map((r) => of(0, 0, r).risk)).toEqual([
			5, 4, 3, 2, 1,
		]);
		// 警戒（40点）
		expect([0, 1.5, 2.5, 4, 6].map((r) => of(0, 40, r).risk)).toEqual([
			3, 4, 5, 4, 3,
		]);
		// 危機（70点）
		expect([0, 1.5, 2.5, 4, 6].map((r) => of(0, 70, r).risk)).toEqual([
			1, 2, 3, 4, 5,
		]);
	});
});
