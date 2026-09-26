import { describe, expect, test } from "bun:test";
import {
	barStep,
	fromChartTime,
	markerColorVar,
	markerShape,
	snapToBar,
	toChartTime,
	toSlots,
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

describe("欠損の空白", () => {
	test("足の間隔は隣り合う足の差の最小値", () => {
		expect(barStep([0, H, 5 * H])).toBe(H);
		expect(barStep([0])).toBeNull();
	});

	test("欠損している足の数だけ空の枠を挟む", () => {
		expect(toSlots([0, H, 4 * H])).toEqual([
			{ time: 0, bar: 0 },
			{ time: H, bar: 1 },
			{ time: 2 * H, bar: null },
			{ time: 3 * H, bar: null },
			{ time: 4 * H, bar: 2 },
		]);
		expect(toSlots([0, H])).toEqual([
			{ time: 0, bar: 0 },
			{ time: H, bar: 1 },
		]);
	});

	test("上限を超えるときは空白を縮め、1枠以上は残す", () => {
		const slots = toSlots([0, H, 101 * H, 102 * H], 13);
		expect(slots).toHaveLength(13);
		expect(slots.filter((s) => s.bar === null)).toHaveLength(9);
		const times = slots.map((s) => s.time);
		expect([...times].sort((a, b) => a - b)).toEqual(times);
		expect(
			toSlots([0, H, 3 * H], 3).filter((s) => s.bar === null),
		).toHaveLength(1);
	});
});
