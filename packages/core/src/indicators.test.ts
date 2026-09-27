import { describe, expect, test } from "bun:test";
import { bollinger, ema, rsi } from "./indicators";

describe("ema", () => {
	test("最初の period 本の単純平均を起点にする", () => {
		const out = ema([1, 2, 3, 4, 5], 3);
		expect(out[0]).toBeNaN();
		expect(out[1]).toBeNaN();
		expect(out[2]).toBe(2);
		// k = 0.5
		expect(out[3]).toBe(3);
		expect(out[4]).toBe(4);
	});

	test("本数が足りなければすべて NaN", () => {
		expect(ema([1, 2], 3).every(Number.isNaN)).toBe(true);
	});
});

describe("rsi", () => {
	test("最初の period 本の値動きの平均を起点にし、以降は 1/period で平滑化する", () => {
		// 値動き: +2, -1 → 上げ平均 1・下げ平均 0.5 → RS 2 → RSI 66.67
		const out = rsi([10, 12, 11, 11], 2);
		expect(out[0]).toBeNaN();
		expect(out[1]).toBeNaN();
		expect(out[2]).toBeCloseTo(66.667, 3);
		// 値動き 0: 上げ 1*1/2 = 0.5・下げ 0.5*1/2 = 0.25 → RS 2
		expect(out[3]).toBeCloseTo(66.667, 3);
	});

	test("下げが無ければ 100、値動きが無ければ 50", () => {
		expect(rsi([1, 2, 3], 2)[2]).toBe(100);
		expect(rsi([5, 5, 5], 2)[2]).toBe(50);
	});

	test("本数が period 以下ならすべて NaN", () => {
		expect(rsi([1, 2], 2).every(Number.isNaN)).toBe(true);
	});
});

describe("bollinger", () => {
	test("中央は単純移動平均、幅は母標準偏差の sigma 倍", () => {
		const { middle, upper, lower } = bollinger([1, 2, 3, 2, 4], 3, 2);
		expect(middle[1]).toBeNaN();
		expect(middle[2]).toBe(2);
		// [1,2,3] の母標準偏差は sqrt(2/3)
		expect(upper[2]).toBeCloseTo(2 + 2 * Math.sqrt(2 / 3));
		expect(lower[2]).toBeCloseTo(2 - 2 * Math.sqrt(2 / 3));
		// [2,3,2] 平均 7/3
		expect(middle[3]).toBeCloseTo(7 / 3);
		expect(middle[4]).toBe(3);
	});

	test("値が動かなければ幅は 0", () => {
		const { upper, lower } = bollinger([5, 5, 5], 3, 2);
		expect(upper[2]).toBe(5);
		expect(lower[2]).toBe(5);
	});
});
