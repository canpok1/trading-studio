import { describe, expect, test } from "bun:test";
import { atr, bollinger, ema, rsi } from "./indicators";

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

describe("atr", () => {
	const bar = (high: number, low: number, close: number) => ({
		high,
		low,
		close,
	});

	test("最初の period 本の TR の平均を起点にし、以降は 1/period で平滑化する", () => {
		const out = atr(
			[
				bar(10, 8, 9),
				// TR: max(12−9, |12−9|, |9−9|) = 3
				bar(12, 9, 11),
				// 前の終値より下に窓を開けた: max(9−8, |9−11|, |8−11|) = 3
				bar(9, 8, 8.5),
				// 前の終値より上に窓を開けた: max(11−10, |11−8.5|, |10−8.5|) = 2.5
				bar(11, 10, 10.5),
			],
			2,
		);
		expect(out[0]).toBeNaN();
		expect(out[1]).toBeNaN();
		// (3 + 3) / 2
		expect(out[2]).toBe(3);
		// (3 × 1 + 2.5) / 2
		expect(out[3]).toBe(2.75);
	});

	test("本数が period 以下ならすべて NaN", () => {
		expect(atr([bar(2, 1, 1), bar(2, 1, 1)], 2).every(Number.isNaN)).toBe(true);
	});
});
