import { describe, expect, test } from "bun:test";
import type { BuyRule, ConditionSet } from "./condition-strategy";
import { DEFAULT_BUY_ORDER, DEFAULT_PARTIAL_SELL } from "./condition-strategy";
import type { EventCalendar } from "./event-calendar";
import { adx, rsi } from "./indicators";
import type { StrategyWatch, WatchAction, WatchInput } from "./strategy-watch";
import { nextMoves, watchConditionSet } from "./strategy-watch";
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
		events: { events: [], covered: [] },
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
			`高値 ${high.toLocaleString("ja-JP")} 円`,
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

	test("ADX の条件は今の値を小数1桁で出し、発動価格は持たない", () => {
		const w = watchConditionSet(
			input(
				params([
					rule({
						buy: {
							match: "all",
							conditions: [
								{
									type: "adx",
									timeframe: "1h",
									period: 14,
									threshold: 20,
									direction: "above",
								},
							],
						},
					}),
				]),
			),
		);
		const v = adx(candles(closes), 14).at(-1) as number;
		expect(w.buys[0]?.buy.conditions[0]).toMatchObject({
			met: v >= 20,
			detail: `今 ${v.toFixed(1)}`,
			// 価格に対して単調でないので発動価格を探さない
			edge: null,
		});
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

	test("損切り後の待ちと、前回から成立が続く買いは理由を返す", () => {
		const p = params([
			rule({
				maxPositions: 2,
				// 判定がまだ無い（データなし）ので成立する
				buy: {
					match: "all",
					conditions: [
						{ type: "judgment", judge: "sentiment", values: ["none"] },
					],
				},
			}),
		]);
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

	test("前回成立していても、今外れていれば買いの発動価格を出す", () => {
		const p = params([
			rule({
				maxPositions: 2,
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
		]);
		const w = watchConditionSet(input(p, { state: { buyHits: { b1: true } } }));
		expect(w.buys[0]?.status).toEqual({ kind: "ready" });
		expect(w.actions.map((a) => a.kind)).toEqual(["entry"]);
	});

	test("建値ストップと損切りの条件が両方成立していれば、次の判定の損切りは1つ", () => {
		const w = watchConditionSet(
			input(params([rule()]), {
				lots: [lot(price + 1_000_000, { partialExitDone: true })],
			}),
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

	test("今の足がまだ無ければ、今の価格の途中の足を足して確定した足を書き換えない", () => {
		const p = params([
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
		]);
		// 最後の足が1本前の時刻に終わっている。直近5本は最後の足まで含む
		const w = watchConditionSet(input(p, { now: (closes.length + 1) * H - 1 }));
		const high = Math.max(...closes.slice(-5));
		expect(w.buys[0]?.buy.triggers).toEqual([high + 1]);
	});

	test("同じ入力なら同じ結果を返す", () => {
		const p = params([rule()]);
		expect(watchConditionSet(input(p, { lots: [lot(price)] }))).toEqual(
			watchConditionSet(input(p, { lots: [lot(price)] })),
		);
	});
});

const act = (
	kind: WatchAction["kind"],
	price: number | null,
	lotId: string | null = null,
): WatchAction => ({ kind, price, buyId: "b1", buyName: "買い1", lotId });

const watchOf = (actions: WatchAction[]): StrategyWatch => ({
	price: 1_000,
	buys: [],
	actions,
});

describe("nextMoves", () => {
	test("上側・下側で一番近い発動価格を1つずつと、次の判定で起きるものを返す", () => {
		const w = watchOf([
			act("takeProfit", 1_100, "o1"),
			act("entry", 1_050),
			act("stopLoss", 900, "o1"),
			act("partialTakeProfit", 950, "o1"),
			act("stopLoss", null, "o2"),
		]);
		const m = nextMoves(w);
		expect(m.up).toEqual(act("entry", 1_050));
		expect(m.down).toEqual(act("partialTakeProfit", 950, "o1"));
		expect(m.now).toEqual([act("stopLoss", null, "o2")]);
	});

	test("同じ価格なら損切りを先に選ぶ", () => {
		const m = nextMoves(
			watchOf([act("entry", 900), act("stopLoss", 900, "o1")]),
		);
		expect(m.down?.kind).toBe("stopLoss");
	});
});

describe("ATR の条件の見張り", () => {
	// 買う前の足は1本 1 万円ずつ上がる（高値・安値＝終値）ので、買った時点の ATR(14) は 1 万円
	const entry = 10_300_000;
	const watchOn = (
		conditions: ConditionSet["buys"][number]["stopLoss"]["conditions"],
	) =>
		watchConditionSet(
			input(params([rule({ stopLoss: { match: "any", conditions } })]), {
				lots: [lot(entry, { openedAt: 20 * H })],
			}),
		);

	test("買値からの ATR は 買値 − ATR × 倍数 が発動価格になる", () => {
		const w = watchOn([
			{
				type: "entryAtr",
				timeframe: "1h",
				period: 14,
				multiple: 2,
				direction: "down",
			},
		]);
		const g = w.buys[0]?.lots[0]?.groups?.stopLoss;
		expect(g?.conditions[0]?.detail).toBe(
			"ATR 10,000 円 ・ 基準 10,280,000 円",
		);
		expect(g?.triggers).toEqual([10_280_000]);
	});

	test("最高値からの ATR は 最高値 − ATR × 倍数 が発動価格になる", () => {
		const w = watchOn([
			{
				type: "trailingAtr",
				timeframe: "1h",
				period: 14,
				multiple: 3,
				activateMultiple: 0,
			},
		]);
		const g = w.buys[0]?.lots[0]?.groups?.stopLoss;
		// 最高値は直近の足が無いので買値
		expect(g?.triggers).toEqual([10_270_000]);
	});
});

describe("予定の前後の見張り", () => {
	const ev = {
		type: "eventWindow" as const,
		minImportance: "high" as const,
		beforeHours: 0,
		afterHours: 24,
		allowNoCalendar: false,
	};
	const p = params([rule({ buy: { match: "all", conditions: [ev] } })]);
	const cpi = Date.parse("2026-09-11T12:30:00Z");
	const nextCpi = Date.parse("2026-10-14T12:30:00Z");
	const until = Date.parse("2027-01-01T00:00:00Z");
	const events: EventCalendar = {
		events: [
			// 2026-06-10 21:30 JST・6/16 の終日・6/18 3:00 JST
			{
				title: "US CPI",
				start: Date.parse("2026-06-10T12:30:00Z"),
				end: Date.parse("2026-06-10T12:30:00Z"),
				importance: "high",
			},
			{
				title: "BOJ",
				start: Date.parse("2026-06-15T15:00:00Z"),
				end: Date.parse("2026-06-16T15:00:00Z"),
				importance: "high",
			},
			{
				title: "FOMC",
				start: Date.parse("2026-06-17T18:00:00Z"),
				end: Date.parse("2026-06-17T18:00:00Z"),
				importance: "high",
			},
			{ title: "US CPI", start: cpi, end: cpi, importance: "high" },
			{ title: "US PPI", start: cpi + H, end: cpi + H, importance: "low" },
			{ title: "US CPI", start: nextCpi, end: nextCpi, importance: "high" },
		],
		covered: [{ from: Date.parse("2026-01-01T00:00:00Z"), until }],
	};
	const watch = (now: number, q = p) =>
		watchConditionSet(input(q, { now, events }));

	test("当たっている間は、どの予定でいつまで買わないかを出し、発動価格は持たない", () => {
		const c = watch(cpi + H).buys[0]?.buy.conditions[0];
		expect(c?.met).toBe(false);
		expect(c?.detail).toBe("「US CPI」の前後（9/12 21:30 まで）");
		expect(c?.edge).toBeNull();
	});

	test("窓が明ける前に次の予定の前の時間が始まれば、その窓の終わりまでを出す", () => {
		const q = params([
			rule({
				buy: { match: "all", conditions: [{ ...ev, afterHours: 48 }] },
			}),
		]);
		expect(
			watch(Date.parse("2026-06-16T00:00:00Z"), q).buys[0]?.buy.conditions[0]
				?.detail,
		).toBe("「BOJ」の前後（6/20 3:00 まで）");
	});

	test("当たっていなければ、重要度が下限以上の次の予定を出す", () => {
		expect(watch(cpi + 25 * H).buys[0]?.buy.conditions[0]?.detail).toBe(
			"次は「US CPI」 10/14 21:30",
		);
	});

	test("暦切れは買いの理由を暦切れにする", () => {
		const b = watch(until + H).buys[0];
		expect(b?.status.kind).toBe("noCalendar");
		expect(b?.buy.conditions[0]?.detail).toContain("暦切れ");
	});

	test("暦切れを成立とみなす条件なら、そう出して買いを止めない", () => {
		const q = params([
			rule({
				buy: { match: "all", conditions: [{ ...ev, allowNoCalendar: true }] },
			}),
		]);
		const b = watch(until + H, q).buys[0];
		expect(b?.status.kind).not.toBe("noCalendar");
		expect(b?.buy.conditions[0]?.met).toBe(true);
		expect(b?.buy.conditions[0]?.detail).toBe(
			"暦切れのため当たらないとみなす（暦は 2027-01-01 9:00 まで）",
		);
	});
});
