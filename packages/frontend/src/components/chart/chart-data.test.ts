import { describe, expect, test } from "bun:test";
import {
	barStep,
	fromChartTime,
	hasOhlc,
	initialRange,
	markerColorVar,
	markerShape,
	showsLatest,
	snapToBar,
	toChartTime,
	toSlots,
	zoomRange,
} from "./chart-data";

const H = 3_600_000;
const DAY = 24 * H;

describe("chart-data", () => {
	test("すべての足に4本値があるときだけローソク足で描ける", () => {
		const full = { time: 0, open: 1, high: 2, low: 1, close: 2 };
		expect(hasOhlc([full, { ...full, time: H }])).toBe(true);
		expect(hasOhlc([full, { time: H, close: 2 }])).toBe(false);
		expect(hasOhlc([])).toBe(false);
	});

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

	test("最初に見せる範囲は足の間隔から本数を決める", () => {
		// 全体は左端の目盛りが切れないよう余白を空ける
		expect(initialRange(null, 100, H)).toEqual({ from: -10, to: 102 });
		expect(initialRange(null, 0, H)).toBeNull();
		expect(initialRange(2 * DAY, 100, H)).toEqual({ from: 51.5, to: 102 });
		// 足が粗くても最低30本は出す
		expect(initialRange(DAY, 100, DAY)).toEqual({ from: 69.5, to: 102 });
		expect(initialRange(DAY, 0, H)).toBeNull();
		// 足りない本数しか無ければ、ある足だけを収める
		expect(initialRange(7 * DAY, 20, H)).toEqual({ from: -2, to: 22 });
	});

	test("拡大・縮小は最新が見えていれば右端を保ち、見えていなければ中央を保つ", () => {
		expect(zoomRange({ from: 60, to: 102 }, 0.5, 100)).toEqual({
			from: 81,
			to: 102,
		});
		expect(zoomRange({ from: 20, to: 60 }, 0.5, 100)).toEqual({
			from: 30,
			to: 50,
		});
		expect(zoomRange({ from: 20, to: 60 }, 2, 100)).toEqual({
			from: 0,
			to: 80,
		});
		// 拡大は10本まで
		expect(zoomRange({ from: 90, to: 102 }, 0.5, 100)).toEqual({
			from: 92,
			to: 102,
		});
		// 全体より広げようとしたら全体を収める
		expect(zoomRange({ from: 40, to: 102 }, 2, 100)).toEqual({
			from: -10,
			to: 102,
		});
	});

	test("最新の足が画面に入っているか", () => {
		expect(showsLatest({ from: 50, to: 99 }, 100)).toBe(true);
		expect(showsLatest({ from: 50, to: 98.5 }, 100)).toBe(false);
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
