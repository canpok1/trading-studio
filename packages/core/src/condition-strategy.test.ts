import { describe, expect, test } from "bun:test";
import type { Condition, ConditionSet } from "./condition-strategy";
import {
	emaPeriods,
	evaluateConditionSet,
	historyBars,
	validateConditionSet,
} from "./condition-strategy";
import type { StrategyInput } from "./strategy";
import { strategyTemplate, TEMPLATE_IDS } from "./templates";
import { TIMEFRAME_MS } from "./timeframe";
import type { Candle, Order, Position } from "./types";
import { EMPTY_POSITION } from "./types";

const H = TIMEFRAME_MS["1h"];

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

function params(over: Partial<ConditionSet> = {}): ConditionSet {
	return {
		timeframe: "1h",
		frequency: {
			flat: { value: 1, unit: "h" },
			holding: { value: 15, unit: "m" },
		},
		orderSize: 1_000_000,
		buy: { match: "all", conditions: [] },
		takeProfit: { match: "any", conditions: [] },
		stopLoss: { match: "any", conditions: [] },
		...over,
	};
}

function input(
	cs: Candle[],
	p: ConditionSet,
	over: Partial<StrategyInput<ConditionSet>> = {},
): StrategyInput<ConditionSet> {
	return {
		now: ((cs.at(-1)?.time ?? 0) as number) + H,
		candles: cs,
		judgments: {},
		position: EMPTY_POSITION,
		cash: 10_000_000,
		openOrders: [],
		params: p,
		state: null,
		...over,
	};
}

const holding = (entryPrice: number): Position => ({
	quantity: 2_000_000,
	entryPrice,
	openedAt: 0,
});

const buyWith = (...conditions: Condition[]) =>
	params({ buy: { match: "all", conditions } });

describe("EMA のクロス", () => {
	// EMA(2) と EMA(3) が最後の足で交差する並び
	const up: Condition = { type: "emaCross", fast: 2, slow: 3, direction: "up" };

	test("1本前は短期 < 長期、今は短期 > 長期なら上抜け", () => {
		const out = evaluateConditionSet(
			input(candles([100, 90, 80, 120]), buyWith(up)),
		);
		expect(out.intents).toHaveLength(1);
		expect(out.note).toContain("短期EMA(2)");
		expect(out.note).toContain("を上抜け");
	});

	test("1本前に値が等しければクロスとみなさない", () => {
		// 1本前: EMA(2) = (90+90)/2 → 90 と EMA(3) = 90 で等しい
		const out = evaluateConditionSet(
			input(candles([90, 90, 90, 120]), buyWith(up)),
		);
		expect(out.intents).toHaveLength(0);
	});

	test("今の足で値が等しければクロスとみなさない", () => {
		const out = evaluateConditionSet(
			input(candles([100, 90, 80, 80]), buyWith(up)),
		);
		expect(out.intents).toHaveLength(0);
	});

	test("下抜け", () => {
		const down: Condition = { ...up, direction: "down" };
		const out = evaluateConditionSet(
			input(candles([80, 90, 100, 60]), buyWith(down)),
		);
		expect(out.note).toContain("を下抜け");
	});

	test("本数が足りない間は判定しない", () => {
		const out = evaluateConditionSet(
			input(candles([100, 90, 120]), buyWith(up)),
		);
		expect(out.intents).toHaveLength(0);
		expect(out.note).toContain("指標の本数が足りない");
	});
});

describe("直近の高値・安値", () => {
	test("終値が現在の足を除く直近 N 本の最高値を上抜けたら成立", () => {
		const c: Condition = { type: "breakout", lookback: 3, direction: "high" };
		expect(
			evaluateConditionSet(input(candles([100, 110, 105, 111]), buyWith(c)))
				.intents,
		).toHaveLength(1);
		expect(
			evaluateConditionSet(input(candles([100, 110, 105, 110]), buyWith(c)))
				.intents,
		).toHaveLength(0);
	});

	test("最安値を下抜け", () => {
		const c: Condition = { type: "breakout", lookback: 2, direction: "low" };
		const out = evaluateConditionSet(
			input(candles([50, 100, 90, 89]), buyWith(c)),
		);
		expect(out.note).toContain("最安値 90 を下抜け");
	});
});

describe("買い", () => {
	const always = buyWith({ type: "breakout", lookback: 1, direction: "high" });
	const rising = candles([13_000_000, 13_500_005]);

	test("現在値の 0.1% 下に円未満切り捨ての指値で、3本で取消", () => {
		const out = evaluateConditionSet(input(rising, always));
		expect(out.intents).toEqual([
			{
				kind: "place",
				side: "buy",
				type: "limit",
				price: 13_486_504,
				quantity: 1_000_000,
				expireAfterBars: 3,
			},
		]);
	});

	test("資金が注文額に足りなければ買わず、理由を書く", () => {
		// 13,486,504 × 0.01 = 134,865.04 円 → 134,866 円必要
		const out = evaluateConditionSet(input(rising, always, { cash: 134_865 }));
		expect(out.intents).toHaveLength(0);
		expect(out.note).toContain("足りないため買わない");
		const enough = evaluateConditionSet(
			input(rising, always, { cash: 134_866 }),
		);
		expect(enough.intents).toHaveLength(1);
	});

	test("未約定の買い注文があれば判定しない", () => {
		const order: Order = {
			id: "o1",
			side: "buy",
			type: "limit",
			price: 1,
			quantity: 1,
			placedAt: 0,
			expiresAt: null,
			status: "open",
		};
		const out = evaluateConditionSet(
			input(rising, always, { openOrders: [order] }),
		);
		expect(out.intents).toHaveLength(0);
	});

	test("すべて満たす / どれか1つ", () => {
		const yes: Condition = { type: "breakout", lookback: 1, direction: "high" };
		const no: Condition = { type: "breakout", lookback: 1, direction: "low" };
		const run = (match: "all" | "any") =>
			evaluateConditionSet(
				input(rising, params({ buy: { match, conditions: [yes, no] } })),
			).intents.length;
		expect(run("all")).toBe(0);
		expect(run("any")).toBe(1);
	});

	test("ポジションなしの判定頻度で次回時刻を返す", () => {
		const cs = candles([100, 90]);
		const out = evaluateConditionSet(input(cs, always));
		expect(out.nextEvalAt).toBe(2 * H + H);
	});
});

describe("売り", () => {
	const gain: Condition = { type: "entryChange", percent: 4, direction: "up" };
	const loss: Condition = {
		type: "entryChange",
		percent: 2,
		direction: "down",
	};
	const sellParams = (tp: Condition[], sl: Condition[]) =>
		params({
			takeProfit: { match: "any", conditions: tp },
			stopLoss: { match: "any", conditions: sl },
		});

	test("買値から % 上がったら保有全量を成行で売る（利確）", () => {
		const out = evaluateConditionSet(
			input(candles([104]), sellParams([gain], [loss]), {
				position: holding(100),
			}),
		);
		expect(out.intents).toEqual([
			{ kind: "place", side: "sell", type: "market", quantity: 2_000_000 },
		]);
		expect(out.note).toContain("保有中の 0.020 BTC を売却（利確の条件）");
	});

	test("買値から % 下がったら損切り", () => {
		const out = evaluateConditionSet(
			input(candles([98]), sellParams([gain], [loss]), {
				position: holding(100),
			}),
		);
		expect(out.note).toContain("（損切りの条件）");
	});

	test("利確と損切りが両方成立したら損切りを優先する", () => {
		const always: Condition = {
			type: "breakout",
			lookback: 1,
			direction: "low",
		};
		const out = evaluateConditionSet(
			input(candles([100, 97]), sellParams([always], [loss]), {
				position: holding(100),
			}),
		);
		expect(out.note).toContain("（損切りの条件）");
	});

	test("どちらも成立しなければ売らない。ポジションありの判定頻度を使う", () => {
		const out = evaluateConditionSet(
			input(candles([101]), sellParams([gain], [loss]), {
				position: holding(100),
			}),
		);
		expect(out.intents).toHaveLength(0);
		expect(out.nextEvalAt).toBe(H + 15 * 60_000);
	});
});

describe("決定論", () => {
	test("同じ入力で同じ出力になる", () => {
		const p = strategyTemplate("trend").params;
		const cs = candles(
			Array.from(
				{ length: 600 },
				(_, i) => 10_000_000 + Math.round(Math.sin(i / 20) * 500_000),
			),
		);
		const a = evaluateConditionSet(input(cs, p));
		const b = evaluateConditionSet(input(cs, p));
		expect(a).toEqual(b);
	});
});

describe("validateConditionSet", () => {
	test("短期EMA は長期EMA より小さくする", () => {
		const errs = validateConditionSet(
			buyWith({ type: "emaCross", fast: 48, slow: 12, direction: "up" }),
		);
		expect(errs).toContainEqual({
			path: "buy.conditions.0.fast",
			message: "長期（12）より小さくする",
		});
	});

	test("買いの条件と損切りの条件は1つ以上必要", () => {
		const paths = validateConditionSet(params()).map((e) => e.path);
		expect(paths).toContain("buy");
		expect(paths).toContain("stopLoss");
	});

	test("買値からの % は買いの条件に使えない", () => {
		const paths = validateConditionSet(
			buyWith({ type: "entryChange", percent: 1, direction: "up" }),
		).map((e) => e.path);
		expect(paths).toContain("buy.conditions.0");
	});

	test("判定頻度と注文量の範囲", () => {
		const errs = validateConditionSet(
			params({
				orderSize: 1,
				frequency: {
					flat: { value: 0, unit: "m" },
					holding: { value: 1.5, unit: "m" },
				},
			}),
		).map((e) => e.path);
		expect(errs).toEqual(
			expect.arrayContaining([
				"orderSize",
				"frequency.flat",
				"frequency.holding",
			]),
		);
	});

	test("ひな形は空以外は検証を通る", () => {
		for (const id of TEMPLATE_IDS) {
			const errs = validateConditionSet(strategyTemplate(id).params);
			expect(errs.map((e) => e.path)).toEqual(id === "blank" ? ["buy"] : []);
		}
	});
});

describe("emaPeriods / historyBars", () => {
	test("条件に出てくる EMA の本数と、必要な足の本数", () => {
		const p = strategyTemplate("trend").params;
		expect(emaPeriods(p)).toEqual([12, 48]);
		expect(historyBars(p)).toBe(481);
	});

	test("ひな形を書き換えても次に取るひな形は変わらない", () => {
		strategyTemplate("trend").params.buy.conditions.length = 0;
		expect(strategyTemplate("trend").params.buy.conditions).toHaveLength(1);
	});
});
