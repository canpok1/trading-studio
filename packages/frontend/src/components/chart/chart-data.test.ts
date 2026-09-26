import { describe, expect, test } from "bun:test";
import {
	fromChartTime,
	markerColorVar,
	markerShape,
	snapToBar,
	toChartTime,
	visibleRange,
} from "./chart-data";

const H = 3_600_000;

describe("chart-data", () => {
	test("描画用の時刻は JST へずらした秒で、元に戻せる", () => {
		const ms = Date.UTC(2026, 8, 25, 15, 0); // JST 9/26 0:00
		const t = toChartTime(ms);
		expect(new Date(t * 1000).toISOString()).toBe("2026-09-26T00:00:00.000Z");
		expect(fromChartTime(t)).toBe(ms);
	});

	test("注文の時刻はそれを含む足に寄せる", () => {
		const bars = [0, H, 2 * H, 3 * H];
		expect(snapToBar(bars, 0)).toBe(0);
		expect(snapToBar(bars, H + 1)).toBe(H);
		expect(snapToBar(bars, 10 * H)).toBe(3 * H);
		expect(snapToBar(bars, -1)).toBeNull();
		expect(snapToBar([], 5)).toBeNull();
	});

	test("アイコンの形と色", () => {
		expect(markerShape({ side: "buy", status: "filled" })).toBe("arrowUp");
		expect(markerShape({ side: "sell", status: "filled" })).toBe("arrowDown");
		expect(markerShape({ side: "buy", status: "open" })).toBe("circle");
		expect(markerShape({ side: "sell", status: "canceled" })).toBe("square");
		expect(markerColorVar({ side: "buy", status: "open" })).toBe("--color-buy");
		expect(markerColorVar({ side: "sell", status: "filled" })).toBe(
			"--color-sell",
		);
		expect(markerColorVar({ side: "buy", status: "canceled" })).toBe(
			"--color-cancel",
		);
	});

	test("表示期間は足の間隔から本数を決める", () => {
		// 全期間は左端の目盛りが切れないよう余白を空ける
		expect(visibleRange("all", 100, H)).toEqual({ from: -10, to: 102 });
		expect(visibleRange("all", 0, H)).toBeNull();
		expect(visibleRange("1d", 100, H)).toEqual({ from: 75.5, to: 102 });
		// 足が粗くても最低5本は出す
		expect(visibleRange("1d", 100, 24 * H)).toEqual({ from: 94.5, to: 102 });
		expect(visibleRange("1w", 0, H)).toBeNull();
		// 期間に足りない本数しか無ければ、ある足だけを収める
		expect(visibleRange("1w", 20, H)).toEqual({ from: -2, to: 22 });
		expect(visibleRange("1d", 24, H)).toEqual({ from: -0.5, to: 26 });
	});
});
