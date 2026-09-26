import { describe, expect, test } from "bun:test";
import { ema } from "./indicators";

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
