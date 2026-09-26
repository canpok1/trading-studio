import { describe, expect, test } from "bun:test";
import { TIMEFRAME_MS } from "@trading-studio/core";
import {
	changePercent,
	collectorTrouble,
	tooManyTimeframes,
	usableTimeframe,
	withLatestPrice,
} from "./home";

const M = TIMEFRAME_MS["1m"];
// JST 2026-09-26 12:00
const T0 = Date.UTC(2026, 8, 26, 3);

describe("ホームの表示", () => {
	test("足が5万本を超える粒度は選べない。全期間は保存済みの本数で見る", () => {
		expect(tooManyTimeframes("1m", {})).toEqual([]);
		expect(tooManyTimeframes("all", { "1m": 60_000, "5m": 12_000 })).toEqual([
			"1m",
		]);
	});

	test("選べない粒度なら、近い粗い粒度にする", () => {
		expect(usableTimeframe("1m", ["1m", "5m"])).toBe("15m");
		expect(usableTimeframe("1h", ["1m"])).toBe("1h");
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
