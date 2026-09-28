import { describe, expect, test } from "bun:test";
import { TIMEFRAME_MS } from "@trading-studio/core";
import { priceSeries } from "./service";

const H = TIMEFRAME_MS["1h"];
const bar = (time: number, close: number) => ({
	time,
	open: close,
	high: close,
	low: close,
	close,
	volume: 0,
});

describe("priceSeries", () => {
	test("確定した最後の足の終値を使い、欠損と最新より先は null", () => {
		// 0 時・1 時の足があり、2 時の足が欠けていて、3 時の足がある
		const p = priceSeries([bar(0, 100), bar(H, 110), bar(3 * H, 130)], "1h");
		expect(p.priceAt(H - 1)).toBeNull();
		expect(p.priceAt(H)).toBe(100);
		expect(p.priceAt(2 * H + 30 * 60_000)).toBe(110);
		expect(p.priceAt(3 * H)).toBeNull();
		expect(p.priceAt(4 * H)).toBe(130);
		expect(p.priceAt(5 * H)).toBeNull();
		expect(p.returnsFrom(H)).toEqual({ "1h": 10, "4h": null, "24h": null });
	});

	test("足が無ければすべて null", () => {
		const p = priceSeries([], null);
		expect(p.priceAt(0)).toBeNull();
		expect(p.returnsFrom(0)).toEqual({ "1h": null, "4h": null, "24h": null });
	});
});
