import { describe, expect, test } from "bun:test";
import { candleStart, coarserTimeframes, isCoarser } from "./timeframe";

// JST の日時をエポックミリ秒へ
const jst = (s: string) => Date.parse(`${s}+09:00`);

describe("candleStart", () => {
	test("日足は JST 0:00 で区切る", () => {
		expect(candleStart(jst("2026-09-26T08:59:59"), "1d")).toBe(
			jst("2026-09-26T00:00:00"),
		);
		expect(candleStart(jst("2026-09-26T23:59:59"), "1d")).toBe(
			jst("2026-09-26T00:00:00"),
		);
	});

	test("4時間足は JST 0:00 から 4 時間ごと", () => {
		expect(candleStart(jst("2026-09-26T03:59:00"), "4h")).toBe(
			jst("2026-09-26T00:00:00"),
		);
		expect(candleStart(jst("2026-09-26T05:00:00"), "4h")).toBe(
			jst("2026-09-26T04:00:00"),
		);
	});

	test("分足は分の区切り", () => {
		expect(candleStart(jst("2026-09-26T12:14:59"), "5m")).toBe(
			jst("2026-09-26T12:10:00"),
		);
		expect(candleStart(jst("2026-09-26T12:14:59"), "1m")).toBe(
			jst("2026-09-26T12:14:00"),
		);
	});
});

describe("粗さの比較", () => {
	test("isCoarser", () => {
		expect(isCoarser("1d", "1h")).toBe(true);
		expect(isCoarser("1m", "1m")).toBe(false);
	});
	test("coarserTimeframes は細かい順", () => {
		expect(coarserTimeframes("15m")).toEqual(["1h", "4h", "1d"]);
		expect(coarserTimeframes("1d")).toEqual([]);
	});
});
