import { describe, expect, test } from "bun:test";
import { aggregateCandles, findGaps, gapsWithin } from "./candles";
import { TIMEFRAME_MS } from "./timeframe";
import type { Candle } from "./types";

const M = TIMEFRAME_MS["1m"];
// JST 2026-09-26 00:00
const DAY = Date.UTC(2026, 8, 25, 15);

const c = (
	time: number,
	o: number,
	h: number,
	l: number,
	cl: number,
): Candle => ({
	time,
	open: o,
	high: h,
	low: l,
	close: cl,
	volume: 10,
});

describe("aggregateCandles", () => {
	test("区切りごとに始値・高値・安値・終値・出来高をまとめる", () => {
		const out = aggregateCandles(
			[
				c(DAY, 10, 12, 9, 11),
				c(DAY + M, 11, 15, 10, 14),
				c(DAY + 5 * M, 14, 14, 13, 13),
			],
			"5m",
		);
		expect(out).toEqual([
			{ time: DAY, open: 10, high: 15, low: 9, close: 14, volume: 20 },
			{ time: DAY + 5 * M, open: 14, high: 14, low: 13, close: 13, volume: 10 },
		]);
	});

	test("日足は JST 0:00 で区切る", () => {
		const out = aggregateCandles(
			[c(DAY - M, 1, 1, 1, 1), c(DAY, 2, 2, 2, 2)],
			"1d",
		);
		expect(out.map((x) => x.time)).toEqual([DAY - TIMEFRAME_MS["1d"], DAY]);
	});
});

describe("findGaps", () => {
	test("本来あるはずの足が無い連続区間を返す。1本でも欠ければ欠損", () => {
		expect(findGaps([0, M, 3 * M, 7 * M, 8 * M], "1m")).toEqual([
			{ from: 2 * M, to: 3 * M, missing: 1 },
			{ from: 4 * M, to: 7 * M, missing: 3 },
		]);
		expect(findGaps([0, M], "1m")).toEqual([]);
	});

	test("期間で切り詰める", () => {
		const gaps = findGaps([0, 10 * M], "1m");
		expect(gapsWithin(gaps, 5 * M, 20 * M, "1m")).toEqual([
			{ from: 5 * M, to: 10 * M, missing: 5 },
		]);
		expect(gapsWithin(gaps, 10 * M, 20 * M, "1m")).toEqual([]);
	});
});
