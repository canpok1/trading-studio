import { describe, expect, test } from "bun:test";
import type { DvolPoint } from "./dvol";
import { dvolAverage, dvolAverageSeries } from "./dvol";

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 1);
// 3日ぶんの1時間足。値は 4000 から1時間ごとに 1 ずつ上がり、12本目は抜けている
const points: DvolPoint[] = Array.from({ length: 72 }, (_, i) => ({
	time: T0 + i * H,
	close: 4000 + i,
})).filter((_, i) => i !== 12);

describe("dvolAverageSeries", () => {
	test("各時刻で dvolAverage と同じ値になり、足りなければ null", () => {
		const times = Array.from(
			{ length: 80 },
			(_, i) => T0 + i * H + 30 * 60_000,
		);
		const got = dvolAverageSeries(points, times, 1);
		times.forEach((t, i) => {
			const want = dvolAverage(points, t, 1);
			expect(got[i]).toBe(want.ok ? want.value : null);
		});
		expect(got[0]).toBeNull();
		expect(got.some((v) => v !== null)).toBe(true);
	});

	test("足が無ければすべて null", () => {
		expect(dvolAverageSeries([], [T0, T0 + H], 1)).toEqual([null, null]);
	});
});
