import { describe, expect, test } from "bun:test";
import { adx, atr, bollinger, ema, rsi, trueRange } from "./indicators";

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

const bars = (rows: [number, number, number][]) =>
	rows.map(([high, low, close]) => ({ high, low, close }));

// 高値・安値・終値
const ADX_BARS = bars([
	[10, 8, 9],
	[12, 9, 11],
	[13, 10, 12],
	[12, 9, 10],
	[11, 8, 9],
]);

describe("trueRange", () => {
	test("高値−安値・前の終値との差の大きい方。最初の足は NaN", () => {
		const out = trueRange(
			bars([
				[10, 8, 9],
				[12, 11, 11.5],
				[10, 9, 9.5],
			]),
		);
		expect(out[0]).toBeNaN();
		// 高値 12 − 前の終値 9
		expect(out[1]).toBe(3);
		// 前の終値 11.5 − 安値 9
		expect(out[2]).toBe(2.5);
	});
});

describe("adx", () => {
	test("Wilder 方式の手計算と一致する", () => {
		// period 2: DX は 100・20・33.33。最初の ADX は (100 + 20) / 2、次は (60 + 33.33) / 2
		const out = adx(ADX_BARS, 2);
		expect(out.slice(0, 3).every(Number.isNaN)).toBe(true);
		expect(out[3]).toBeCloseTo(60, 6);
		expect(out[4]).toBeCloseTo(46.667, 3);
	});

	test("値動きが無ければ 0", () => {
		const flat = bars([
			[5, 5, 5],
			[5, 5, 5],
			[5, 5, 5],
			[5, 5, 5],
		]);
		expect(adx(flat, 2)[3]).toBe(0);
	});

	test("本数が 2 × period 未満ならすべて NaN", () => {
		expect(adx(ADX_BARS.slice(0, 3), 2).every(Number.isNaN)).toBe(true);
	});
});

describe("atr", () => {
	test("最初の period 本の TR の平均を起点にし、以降は 1/period で平滑化する", () => {
		const out = atr(
			bars([
				[10, 8, 9],
				// TR: max(12−9, |12−9|, |9−9|) = 3
				[12, 9, 11],
				// 前の終値より下に窓を開けた: max(9−8, |9−11|, |8−11|) = 3
				[9, 8, 8.5],
				// 前の終値より上に窓を開けた: max(11−10, |11−8.5|, |10−8.5|) = 2.5
				[11, 10, 10.5],
			]),
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
		expect(
			atr(
				bars([
					[2, 1, 1],
					[2, 1, 1],
				]),
				2,
			).every(Number.isNaN),
		).toBe(true);
	});
});
