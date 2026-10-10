import { describe, expect, test } from "bun:test";
import type { BuyRule, ConditionSet } from "./condition-strategy";
import { DEFAULT_BUY_ORDER, DEFAULT_PARTIAL_SELL } from "./condition-strategy";
import { rsi } from "./indicators";
import type { WatchInput } from "./strategy-watch";
import { watchConditionSet } from "./strategy-watch";
import { TIMEFRAME_MS } from "./timeframe";
import type { Candle, Lot, Order } from "./types";

const H = TIMEFRAME_MS["1h"];
const BTC = 100_000_000;

function candles(closes: number[]): Candle[] {
	return closes.map((close, i) => ({
		time: i * H,
		open: close,
		high: close,
		low: close,
		close,
		volume: 0,
	}));
}

function rule(over: Partial<BuyRule> = {}): BuyRule {
	return {
		id: "b1",
		name: "買い1",
		orderSize: BTC / 100,
		maxPositions: 1,
		buy: { match: "all", conditions: [] },
		buyOrder: DEFAULT_BUY_ORDER,
		partialTakeProfit: { match: "any", conditions: [] },
		partialSell: DEFAULT_PARTIAL_SELL,
		takeProfit: { match: "any", conditions: [] },
		stopLoss: {
			match: "any",
			conditions: [{ type: "entryChange", percent: 2, direction: "down" }],
		},
		...over,
	};
}

function params(buys: BuyRule[]): ConditionSet {
	return {
		frequency: {
			flat: { value: 1, unit: "h" },
			holding: { value: 1, unit: "h" },
		},
		dailyLossLimit: 30_000,
		stopLossCooldownBars: 0,
		stopLossCooldownTimeframe: "1h",
		buys,
	};
}

// 1000万円から 1 万円ずつ上がり、最後（今の価格の途中の足）だけ 5 万円下がる
const closes = Array.from({ length: 40 }, (_, i) =>
	i === 39 ? 10_000_000 + 38 * 10_000 - 50_000 : 10_000_000 + i * 10_000,
);
const price = closes.at(-1) as number;

function input(p: ConditionSet, over: Partial<WatchInput> = {}): WatchInput {
	return {
		now: closes.length * H,
		price,
		candles: { "1h": candles(closes) },
		recent: { timeframeMs: TIMEFRAME_MS["1m"], candles: [] },
		judgments: {},
		lots: [],
		cash: 100_000_000,
		openOrders: [],
		params: p,
		state: null,
		buyBlocked: null,
		...over,
	};
}

const lot = (entryPrice: number, over: Partial<Lot> = {}): Lot => ({
	id: "o1",
	quantity: BTC / 100,
	entryPrice,
	openedAt: 0,
	buyId: "b1",
	...over,
});

describe("watchConditionSet", () => {
	test("直近の高値の突破は、高値を超える価格が買いの発動価格になる", () => {
		const w = watchConditionSet(
			input(
				params([
					rule({
						buy: {
							match: "all",
							conditions: [
								{
									type: "breakout",
									timeframe: "1h",
									lookback: 5,
									direction: "high",
								},
							],
						},
					}),
				]),
			),
		);
		const b = w.buys[0];
		// 今の足を除く直近5本の最高値は1本前の終値
		const high = closes.at(-2) as number;
		expect(b?.status).toEqual({ kind: "ready" });
		expect(b?.buy.met).toBe(false);
		expect(b?.buy.conditions[0]?.detail).toBe(
			`高値 ${high.toLocaleString("ja-JP")}`,
		);
		expect(b?.buy.triggers).toEqual([high + 1]);
		expect(w.actions).toEqual([
			{
				kind: "entry",
				price: high + 1,
				buyId: "b1",
				buyName: "買い1",
				lotId: null,
			},
		]);
	});

	test("RSI の発動価格では RSI がしきい値を満たし、1円手前では満たさない", () => {
		const w = watchConditionSet(
			input(
				params([
					rule({
						buy: {
							match: "all",
							conditions: [
								{
									type: "rsi",
									timeframe: "1h",
									period: 14,
									threshold: 30,
									direction: "below",
								},
							],
						},
					}),
				]),
			),
		);
		const t = w.buys[0]?.buy.triggers[0] as number;
		expect(t).toBeLessThan(price);
		const at = (x: number) =>
			rsi([...closes.slice(0, -1), x], 14).at(-1) as number;
		expect(at(t)).toBeLessThanOrEqual(30);
		expect(at(t + 1)).toBeGreaterThan(30);
	});

	test("すべて満たすのグループは、価格で変わらない条件が不成立なら発動価格を出さない", () => {
		const w = watchConditionSet(
			input(
				params([
					rule({
						buy: {
							match: "all",
							conditions: [
								{
									type: "breakout",
									timeframe: "1h",
									lookback: 5,
									direction: "high",
								},
								{ type: "judgment", judge: "sentiment", values: ["+1"] },
							],
						},
					}),
				]),
				{
					judgments: {
						sentiment: [{ judge: "sentiment", time: 0, label: "0" }],
					},
				},
			),
		);
		expect(w.buys[0]?.buy.conditions[1]).toMatchObject({
			met: false,
			edge: null,
			detail: "今 中立",
		});
		expect(w.buys[0]?.buy.triggers).toEqual([]);
		expect(w.actions).toEqual([]);
	});

	test("枠が埋まっている買いは発動価格を出さず、ロットの利確・損切りの価格を出す", () => {
		const entry = 10_000_000;
		const w = watchConditionSet(
			input(
				params([
					rule({
						buy: {
							match: "all",
							conditions: [
								{
									type: "breakout",
									timeframe: "1h",
									lookback: 5,
									direction: "high",
								},
							],
						},
						takeProfit: {
							match: "any",
							conditions: [
								{ type: "entryChange", percent: 5, direction: "up" },
							],
						},
					}),
				]),
				{ lots: [lot(entry)] },
			),
		);
		const b = w.buys[0];
		expect(b?.status).toEqual({ kind: "full" });
		expect(b?.lots[0]?.groups?.stopLoss?.triggers).toEqual([9_800_000]);
		expect(b?.lots[0]?.groups?.takeProfit?.triggers).toEqual([10_500_000]);
		expect(w.actions.map((a) => [a.kind, a.price])).toEqual([
			["stopLoss", 9_800_000],
			["takeProfit", 10_500_000],
		]);
	});

	test("成立済みのグループは、次の判定で起きる売買として価格なしで出す", () => {
		const w = watchConditionSet(
			input(params([rule()]), { lots: [lot(price + 1_000_000)] }),
		);
		expect(w.actions).toEqual([
			{
				kind: "stopLoss",
				price: null,
				buyId: "b1",
				buyName: "買い1",
				lotId: "o1",
			},
		]);
	});

	test("売りの約定待ちのロットは判定しない", () => {
		const sell: Order = {
			id: "o2",
			side: "sell",
			type: "market",
			price: null,
			quantity: BTC / 100,
			placedAt: 0,
			expiresAt: null,
			status: "open",
			lotId: "o1",
		};
		const w = watchConditionSet(
			input(params([rule()]), { lots: [lot(price)], openOrders: [sell] }),
		);
		expect(w.buys[0]?.lots[0]).toMatchObject({ selling: true, groups: null });
		expect(w.actions).toEqual([]);
	});

	test("トレーリングストップは発動前なら最高値と未発動を出す", () => {
		const entry = price - 100_000;
		const w = watchConditionSet(
			input(
				params([
					rule({
						stopLoss: {
							match: "any",
							conditions: [
								{ type: "trailingStop", percent: 3, activatePercent: 5 },
							],
						},
					}),
				]),
				{ lots: [lot(entry)] },
			),
		);
		const c = w.buys[0]?.lots[0]?.groups?.stopLoss?.conditions[0];
		expect(c?.detail).toStartWith("未発動");
		expect(c?.edge).toBeNull();
	});

	test("損切り後の待ちと、前回成立していた買いは理由を返す", () => {
		const p = params([rule({ maxPositions: 2 })]);
		const cooled = watchConditionSet(
			input(
				{ ...p, stopLossCooldownBars: 3 },
				{ state: { stopLossAt: closes.length * H - H } },
			),
		);
		expect(cooled.buys[0]?.status).toEqual({
			kind: "cooldown",
			barsLeft: 2,
			timeframe: "1h",
		});
		const cont = watchConditionSet(
			input(p, { state: { buyHits: { b1: true } } }),
		);
		expect(cont.buys[0]?.status).toEqual({ kind: "continuing" });
	});

	test("同じ入力なら同じ結果を返す", () => {
		const p = params([rule()]);
		expect(watchConditionSet(input(p, { lots: [lot(price)] }))).toEqual(
			watchConditionSet(input(p, { lots: [lot(price)] })),
		);
	});
});
