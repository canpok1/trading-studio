import { describe, expect, test } from "bun:test";
import type { MarketTrade, MinuteCandleState } from "./market-trades";
import {
	addTrade,
	closeMinutes,
	formingCandle,
	startMinuteCandles,
} from "./market-trades";
import { TIMEFRAME_MS } from "./timeframe";

const M = TIMEFRAME_MS["1m"];
const S = 1_000;
// JST 2026-09-26 12:00
const T0 = Date.UTC(2026, 8, 26, 3);

let nextId = 1;
const tr = (time: number, price: number, quantity = 100): MarketTrade => ({
	id: nextId++,
	time,
	price,
	quantity,
});

function feed(
	state: MinuteCandleState,
	trades: MarketTrade[],
): MinuteCandleState {
	return trades.reduce(addTrade, state);
}

describe("1分足の組み立て", () => {
	test("1分の中の約定から始値・高値・安値・終値・出来高を作る。時刻の前後は問わない", () => {
		const a = tr(T0 + 1 * S, 100, 10);
		const b = tr(T0 + 20 * S, 130, 20);
		const c = tr(T0 + 40 * S, 90, 30);
		const d = tr(T0 + 59 * S, 110, 40);
		const s = feed(startMinuteCandles(T0), [b, d, a, c]);
		const { candles } = closeMinutes(s, T0 + M + 2 * S);
		expect(candles).toEqual([
			{ time: T0, open: 100, high: 130, low: 90, close: 110, volume: 100 },
		]);
	});

	test("同じ時刻の約定は ID の順に並べる", () => {
		const first = { id: 10, time: T0 + S, price: 100, quantity: 1 };
		const second = { id: 11, time: T0 + S, price: 200, quantity: 1 };
		const s = feed(startMinuteCandles(T0), [second, first]);
		const [candle] = closeMinutes(s, T0 + 2 * M).candles;
		expect(candle?.open).toBe(100);
		expect(candle?.close).toBe(200);
	});

	test("同じ ID の約定は1回だけ数える", () => {
		const a = tr(T0 + S, 100, 10);
		const s = feed(startMinuteCandles(T0), [a, a]);
		expect(closeMinutes(s, T0 + 2 * M).candles[0]?.volume).toBe(10);
	});

	test("分が終わっても猶予の間は確定しない", () => {
		const s = feed(startMinuteCandles(T0), [tr(T0 + S, 100)]);
		expect(closeMinutes(s, T0 + M + S).candles).toEqual([]);
		expect(closeMinutes(s, T0 + M + 2 * S).candles).toHaveLength(1);
	});

	test("約定の無い分は直前の終値で横ばい・出来高 0 の足にする", () => {
		const s = feed(startMinuteCandles(T0), [
			tr(T0 + S, 100),
			tr(T0 + 3 * M, 120),
		]);
		const { candles } = closeMinutes(s, T0 + 4 * M + 2 * S);
		expect(candles.map((c) => [c.time, c.open, c.close, c.volume])).toEqual([
			[T0, 100, 100, 100],
			[T0 + M, 100, 100, 0],
			[T0 + 2 * M, 100, 100, 0],
			[T0 + 3 * M, 120, 120, 100],
		]);
	});

	test("受け始めた分は途中からなので足を作らず、その分の約定を直前の価格にだけ使う", () => {
		const start = T0 + 30 * S;
		const s = feed(startMinuteCandles(start), [tr(T0 + 40 * S, 100)]);
		const { candles } = closeMinutes(s, T0 + 2 * M + 2 * S);
		expect(candles).toEqual([
			{ time: T0 + M, open: 100, high: 100, low: 100, close: 100, volume: 0 },
		]);
	});

	test("直前の価格が分からない、約定の無い分は作らない", () => {
		const s = feed(startMinuteCandles(T0), [tr(T0 + 2 * M + S, 100)]);
		const { candles } = closeMinutes(s, T0 + 3 * M + 2 * S);
		expect(candles.map((c) => c.time)).toEqual([T0 + 2 * M]);
	});

	test("受け始める前の期間には足を作らず、その期間の約定を直前の価格にも使わない", () => {
		const s = feed(startMinuteCandles(T0 + 5 * M), [tr(T0 + S, 100)]);
		const { candles } = closeMinutes(s, T0 + 6 * M + 2 * S);
		expect(candles).toEqual([]);
	});

	test("確定済みの分に遅れて届いた約定は捨てる", () => {
		let s = feed(startMinuteCandles(T0), [tr(T0 + S, 100)]);
		s = closeMinutes(s, T0 + M + 2 * S).state;
		const late = tr(T0 + 50 * S, 999);
		expect(addTrade(s, late)).toBe(s);
	});

	test("形成中の足はその分の約定だけで作り、約定が無ければ直前の価格で横ばいにする", () => {
		let s = feed(startMinuteCandles(T0), [
			tr(T0 + S, 100),
			tr(T0 + M + S, 120, 5),
		]);
		expect(formingCandle(s, T0 + M + 10 * S)).toEqual({
			time: T0 + M,
			open: 120,
			high: 120,
			low: 120,
			close: 120,
			volume: 5,
		});
		s = closeMinutes(s, T0 + 2 * M + 2 * S).state;
		expect(formingCandle(s, T0 + 2 * M + 10 * S)?.close).toBe(120);
		expect(formingCandle(startMinuteCandles(T0), T0 + S)).toBeNull();
	});

	test("価格・数量が整数でない約定は受け付けない", () => {
		expect(() =>
			addTrade(startMinuteCandles(T0), {
				id: 1,
				time: T0,
				price: 100.5,
				quantity: 1,
			}),
		).toThrow(RangeError);
	});

	test("同じ入力なら同じ結果になる", () => {
		const trades = [tr(T0 + S, 100), tr(T0 + M + S, 110), tr(T0 + 3 * M, 90)];
		const run = () =>
			closeMinutes(feed(startMinuteCandles(T0), trades), T0 + 5 * M).candles;
		expect(run()).toEqual(run());
	});
});
