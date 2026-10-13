import { describe, expect, test } from "bun:test";
import { TIMEFRAME_MS } from "@trading-studio/core";
import {
	changePercent,
	collectorTrouble,
	judgmentsFrom,
	loadRange,
	withLatestPrice,
} from "./home";

const M = TIMEFRAME_MS["1m"];
// JST 2026-09-26 12:00
const T0 = Date.UTC(2026, 8, 26, 3);

describe("ホームの表示", () => {
	test("読み込む期間は、上限の本数に収まる最も長い期間。全期間は保存済みの本数で見る", () => {
		expect(loadRange("1d", { "1d": 400 })).toBe("all");
		expect(loadRange("1m", { "1m": 60_000 })).toBe("1w");
		expect(loadRange("5m", { "5m": 30_000 })).toBe("1m");
		// 1日も収まらない上限なら1日にする
		expect(loadRange("1m", { "1m": 60_000 }, 100)).toBe("1d");
	});

	test("判定を問い合わせる期間は、長すぎれば最後の足から遡る分だけにする", () => {
		expect(judgmentsFrom(T0, T0 + 10 * M, "1m")).toBe(T0);
		expect(judgmentsFrom(T0, T0 + 60_000 * M, "1m")).toBe(T0 + 10_000 * M);
	});

	test("最新の価格を、同じ足なら終値の置き換え、新しい足なら追加で反映する", () => {
		const bars = [
			{ time: T0, close: 1 },
			{ time: T0 + M, close: 2 },
		];
		expect(withLatestPrice(bars, "1m", 5, T0 + M + 10_000)).toEqual([
			{ time: T0, close: 1 },
			{ time: T0 + M, close: 5 },
		]);
		expect(withLatestPrice(bars, "1m", 5, T0 + 2 * M)).toHaveLength(3);
		expect(withLatestPrice(bars, "5m", 5, T0 + 2 * M)).toEqual([
			{ time: T0, close: 1 },
			{ time: T0 + M, close: 2 },
		]);
		expect(withLatestPrice(bars, "1m", null, null)).toEqual(bars);
	});

	test("4本値のある足へ最新の価格を反映すると、高値・安値も広げる", () => {
		const bars = [{ time: T0, open: 10, high: 12, low: 9, close: 11 }];
		expect(withLatestPrice(bars, "1m", 13, T0 + 10_000)).toEqual([
			{ time: T0, open: 10, high: 13, low: 9, close: 13 },
		]);
		expect(withLatestPrice(bars, "1m", 8, T0 + 10_000)).toEqual([
			{ time: T0, open: 10, high: 12, low: 8, close: 8 },
		]);
		expect(withLatestPrice(bars, "1m", 7, T0 + M).at(-1)).toEqual({
			time: T0 + M,
			open: 7,
			high: 7,
			low: 7,
			close: 7,
		});
	});

	test("24時間の変化率", () => {
		expect(changePercent(110, 100)).toBeCloseTo(10);
		expect(changePercent(110, null)).toBeNull();
	});

	test("止まっているときだけ、何が起きたか・いつからか・再接続を出す", () => {
		const running = {
			state: "running" as const,
			stoppedSince: null,
			error: null,
			retryAt: null,
			lastReceivedAt: null,
		};
		expect(collectorTrouble(running)).toBeNull();
		expect(
			collectorTrouble({
				...running,
				state: "stopped",
				error: "切れた",
				stoppedSince: T0,
				retryAt: T0 + 4_000,
			}),
		).toEqual({
			what: "切れた",
			since: "2026/09/26 12:00:00",
			retry: "自動で再接続中（次は 12:00:04）",
		});
	});
});
