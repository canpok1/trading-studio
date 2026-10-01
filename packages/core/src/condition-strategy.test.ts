import { describe, expect, test } from "bun:test";
import type {
	BuyOrderLine,
	Condition,
	ConditionSet,
	SingleBuyConditionSet,
} from "./condition-strategy";
import {
	acceptsNoJudgment as acceptsNoJudgmentOf,
	candleNeeds as candleNeedsOf,
	candleTimeframes as candleTimeframesOf,
	chooseStepTimeframe as chooseStepTimeframeOf,
	conditionStrategy as conditionStrategyOf,
	DEFAULT_BUY_ORDER,
	DEFAULT_PARTIAL_SELL,
	emaPeriods as emaPeriodsOf,
	evaluateConditionSet,
	historyShortfalls as historyShortfallsOf,
	MARKET_BUY_ORDER,
	parseConditionSet as parseConditionSetOf,
	recentMs as recentMsOf,
	rsiLines as rsiLinesOf,
	singleBuy,
	validateConditionSet as validateConditionSetOf,
} from "./condition-strategy";
import type { StrategyInput } from "./strategy";
import type { TemplateId } from "./templates";
import {
	strategyTemplate as strategyTemplateOf,
	TEMPLATE_IDS,
} from "./templates";
import type { Timeframe } from "./timeframe";
import { TIMEFRAME_MS } from "./timeframe";
import type { Candle, Order, Position } from "./types";
import { EMPTY_POSITION } from "./types";

// このファイルの多くのテストは買い1つの戦略を平らな形（Flat）で書き、関数に渡すときに買い1つの条件セットにする。
// 入力検証のパスは先頭の「buys.0.」を外して比べる。買いを複数持つ動きは「複数の買い」で確かめる
type Flat = SingleBuyConditionSet;
const toSet = (p: Flat | ConditionSet): ConditionSet =>
	"buys" in p ? p : singleBuy(p);
function flat(p: ConditionSet): Flat {
	const { buys, ...rest } = p;
	const {
		id: _id,
		name: _name,
		...rule
	} = buys[0] as ConditionSet["buys"][number];
	return { ...rest, ...rule };
}
const acceptsNoJudgment = (p: Flat) => acceptsNoJudgmentOf(toSet(p));
const candleNeeds = (p: Flat) => candleNeedsOf(toSet(p));
const candleTimeframes = (p: Flat) => candleTimeframesOf(toSet(p));
const chooseStepTimeframe = (p: Flat, finest: Timeframe) =>
	chooseStepTimeframeOf(toSet(p), finest);
const emaPeriods = (p: Flat) => emaPeriodsOf(toSet(p));
const historyShortfalls = (
	p: Flat,
	...rest: Parameters<typeof historyShortfallsOf> extends [unknown, ...infer R]
		? R
		: never
) => historyShortfallsOf(toSet(p), ...rest);
const recentMs = (p: Flat) => recentMsOf(toSet(p));
const rsiLines = (p: Flat) => rsiLinesOf(toSet(p));
const validateConditionSet = (p: Flat | ConditionSet) =>
	validateConditionSetOf(toSet(p)).map((e) => ({
		...e,
		path: e.path.replace(/^buys\.0\./, ""),
	}));
const parseConditionSet = (v: unknown): Flat | null => {
	const p = parseConditionSetOf(v);
	return p ? flat(p) : null;
};
const strategyTemplate = (id: TemplateId) => {
	const t = strategyTemplateOf(id);
	return { ...t, params: flat(t.params) };
};
const conditionStrategy = {
	requiredJudges: (p: Flat) => conditionStrategyOf.requiredJudges(toSet(p)),
};

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

function params(over: Partial<Flat> = {}): Flat {
	return {
		frequency: {
			flat: { value: 1, unit: "h" },
			holding: { value: 15, unit: "m" },
		},
		orderSize: 1_000_000,
		maxPositions: 1,
		dailyLossLimit: 30_000,
		stopLossCooldownBars: 0,
		stopLossCooldownTimeframe: "1h",
		buy: { match: "all", conditions: [] },
		buyOrder: DEFAULT_BUY_ORDER,
		partialTakeProfit: { match: "all", conditions: [] },
		partialSell: DEFAULT_PARTIAL_SELL,
		takeProfit: { match: "any", conditions: [] },
		stopLoss: { match: "any", conditions: [] },
		...over,
	};
}

function input(
	cs: Candle[],
	p: Flat | ConditionSet,
	over: Partial<StrategyInput<ConditionSet>> = {},
): StrategyInput<ConditionSet> {
	const position = over.position ?? EMPTY_POSITION;
	return {
		now: ((cs.at(-1)?.time ?? 0) as number) + H,
		price: cs.at(-1)?.close ?? 0,
		candles: { "1h": cs },
		recent: { timeframeMs: H, candles: cs },
		judgments: {},
		position,
		// 保有を渡したら1ロットとして持つ
		lots:
			position.quantity > 0
				? [
						{
							id: "b1",
							quantity: position.quantity,
							entryPrice: position.entryPrice ?? 0,
							openedAt: position.openedAt ?? 0,
						},
					]
				: [],
		cash: 10_000_000,
		openOrders: [],
		params: toSet(p),
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
	const up: Condition = {
		type: "emaCross",
		timeframe: "1h",
		fast: 2,
		slow: 3,
		direction: "up",
	};

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

describe("RSI", () => {
	const below: Condition = {
		type: "rsi",
		timeframe: "1h",
		period: 2,
		threshold: 30,
		direction: "below",
	};

	test("RSI がしきい値以下なら成立し、値を記録に残す", () => {
		// 値動き -10, -10 → RSI 0
		const out = evaluateConditionSet(
			input(candles([100, 90, 80]), buyWith(below)),
		);
		expect(out.intents).toHaveLength(1);
		expect(out.note).toContain("RSI(2) 0.0 が 30 以下");
	});

	test("しきい値ちょうども成立し、超えれば成立しない", () => {
		// 値動き +2, -1 → RSI 66.67
		const at: Condition = { ...below, threshold: 66, direction: "above" };
		expect(
			evaluateConditionSet(input(candles([10, 12, 11]), buyWith(at))).intents,
		).toHaveLength(1);
		expect(
			evaluateConditionSet(input(candles([10, 12, 11]), buyWith(below)))
				.intents,
		).toHaveLength(0);
		// 下げだけ → RSI 0 は「以下」のしきい値 1 でも成立
		const edge: Condition = { ...below, threshold: 1 };
		expect(
			evaluateConditionSet(input(candles([10, 9, 8]), buyWith(edge))).intents,
		).toHaveLength(1);
	});

	test("本数が足りない間は判定しない", () => {
		const out = evaluateConditionSet(input(candles([100, 90]), buyWith(below)));
		expect(out.intents).toHaveLength(0);
		expect(out.note).toContain("RSI(2) に 3 本必要");
	});

	test("期間としきい値の範囲", () => {
		const errs = validateConditionSet(
			buyWith({ ...below, period: 1, threshold: 100 }),
		).map((e) => e.path);
		expect(errs).toContain("buy.conditions.0.period");
		expect(errs).toContain("buy.conditions.0.threshold");
		expect(
			validateConditionSet(
				buyWith({ ...below, period: 100, threshold: 99 }),
			).filter((e) => e.path.startsWith("buy.conditions")),
		).toEqual([]);
	});

	test("チャートに出す RSI は本数ごとに、条件のしきい値をまとめる", () => {
		const p = params({
			buy: { match: "all", conditions: [{ ...below, period: 14 }] },
			takeProfit: {
				match: "any",
				conditions: [
					{ ...below, period: 14, threshold: 70, direction: "above" },
					{ ...below, period: 7, threshold: 80, direction: "above" },
				],
			},
			stopLoss: {
				match: "any",
				conditions: [{ ...below, period: 14, threshold: 30 }],
			},
		});
		expect(rsiLines(p)).toEqual([
			{ period: 7, thresholds: [80] },
			{ period: 14, thresholds: [30, 70] },
		]);
		expect(rsiLines(buyWith())).toEqual([]);
	});

	test("必要な足の本数は期間の 10 倍 + 1", () => {
		expect(candleNeeds(buyWith({ ...below, period: 14 }))["1h"]).toBe(141);
	});

	test("JSON から読み戻せる", () => {
		const p = buyWith(below);
		expect(parseConditionSet(JSON.parse(JSON.stringify(p)))).toEqual(p);
		expect(
			parseConditionSet(
				JSON.parse(
					JSON.stringify(buyWith({ ...below, direction: "up" as "above" })),
				),
			),
		).toBeNull();
	});
});

describe("直近の高値・安値", () => {
	test("終値が現在の足を除く直近 N 本の最高値を上抜けたら成立", () => {
		const c: Condition = {
			type: "breakout",
			timeframe: "1h",
			lookback: 3,
			direction: "high",
		};
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
		const c: Condition = {
			type: "breakout",
			timeframe: "1h",
			lookback: 2,
			direction: "low",
		};
		const out = evaluateConditionSet(
			input(candles([50, 100, 90, 89]), buyWith(c)),
		);
		expect(out.note).toContain("最安値 90 を下抜け");
	});
});

describe("買い", () => {
	const always = buyWith({
		type: "breakout",
		timeframe: "1h",
		lookback: 1,
		direction: "high",
	});
	const rising = candles([13_000_000, 13_500_005]);

	test("現在値の 0.1% 下に円未満切り捨ての指値で、3本で取消", () => {
		const out = evaluateConditionSet(input(rising, always));
		expect(out.intents).toEqual([
			{
				kind: "place",
				side: "buy",
				buyId: "b1",
				type: "limit",
				price: 13_486_504,
				quantity: 1_000_000,
				expireAfterMs: 3 * H,
			},
		]);
	});

	test("値幅と取消までの本数は戦略の設定に従う", () => {
		const out = evaluateConditionSet(
			input(rising, {
				...always,
				buyOrder: {
					lines: [{ type: "limit", belowPercent: 1.25 }],
					expireBars: 10,
					expireTimeframe: "1h",
				},
			}),
		);
		// 13,500,005 × 98.75% = 13,331,254.9... → 13,331,254
		expect(out.intents).toEqual([
			{
				kind: "place",
				side: "buy",
				buyId: "b1",
				type: "limit",
				price: 13_331_254,
				quantity: 1_000_000,
				expireAfterMs: 10 * H,
			},
		]);
		expect(out.note).toContain("1.25% 下");
	});

	test("成行なら価格と期限を持たずに出す。資金は現在値で見積もる", () => {
		const market = {
			...always,
			buyOrder: MARKET_BUY_ORDER,
		};
		const out = evaluateConditionSet(input(rising, market));
		expect(out.intents).toEqual([
			{
				kind: "place",
				side: "buy",
				buyId: "b1",
				type: "market",
				quantity: 1_000_000,
			},
		]);
		expect(out.note).toContain("成行で");
		// 13,500,005 × 0.01 = 135,000.05 円 → 135,001 円必要
		const short = evaluateConditionSet(
			input(rising, market, { cash: 135_000 }),
		);
		expect(short.intents).toHaveLength(0);
		expect(short.note).toContain("足りないため買わない");
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
		const yes: Condition = {
			type: "breakout",
			timeframe: "1h",
			lookback: 1,
			direction: "high",
		};
		const no: Condition = {
			type: "breakout",
			timeframe: "1h",
			lookback: 1,
			direction: "low",
		};
		const run = (match: "all" | "any") =>
			evaluateConditionSet(
				input(rising, params({ buy: { match, conditions: [yes, no] } })),
			).intents.length;
		expect(run("all")).toBe(0);
		expect(run("any")).toBe(1);
	});

	test("保有なしの判定頻度で次回時刻を返す", () => {
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
			{
				kind: "place",
				side: "sell",
				type: "market",
				quantity: 2_000_000,
				lotId: "b1",
				exitKind: "takeProfit",
			},
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
			timeframe: "1h",
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

	test("どちらも成立しなければ売らない。保有中の判定頻度を使う", () => {
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
			buyWith({
				type: "emaCross",
				timeframe: "1h",
				fast: 48,
				slow: 12,
				direction: "up",
			}),
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
				dailyLossLimit: 30_000,
				stopLossCooldownBars: 0,
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

	test("買いの指値の値幅と取消までの本数", () => {
		const errs = (buyOrder: Flat["buyOrder"]) =>
			validateConditionSet({
				...strategyTemplate("range").params,
				buyOrder,
			}).map((e) => e.path);
		const limit = (belowPercent: number, expireBars = 3) =>
			errs({
				lines: [{ type: "limit", belowPercent }],
				expireBars,
				expireTimeframe: "1h",
			});
		expect(limit(0)).toEqual([]);
		expect(limit(99.99, 100)).toEqual([]);
		expect(limit(100)).toEqual(["buyOrder.lines.0.belowPercent"]);
		expect(limit(-0.01)).toEqual(["buyOrder.lines.0.belowPercent"]);
		expect(limit(0.125)).toEqual(["buyOrder.lines.0.belowPercent"]);
		expect(limit(0.1, 0)).toEqual(["buyOrder.expireBars"]);
		expect(limit(0.1, 101)).toEqual(["buyOrder.expireBars"]);
		// 成行だけなら本数を見ない
		expect(
			errs({
				lines: [{ type: "market" }],
				expireBars: 0,
				expireTimeframe: "1h",
			}),
		).toEqual([]);
	});

	test("買い注文の行: 成行は先頭の1行だけ、指値は下の行ほど大きい %、1〜10 行", () => {
		const errs = (lines: BuyOrderLine[]) =>
			validateConditionSet({
				...strategyTemplate("range").params,
				buyOrder: { lines, expireBars: 3, expireTimeframe: "1h" },
			}).map((e) => e.path);
		const lim = (belowPercent: number): BuyOrderLine => ({
			type: "limit",
			belowPercent,
		});
		expect(errs([{ type: "market" }, lim(0.5), lim(1)])).toEqual([]);
		expect(errs([lim(0.5), { type: "market" }])).toEqual(["buyOrder.lines.1"]);
		expect(errs([lim(1), lim(1)])).toEqual(["buyOrder.lines.1.belowPercent"]);
		expect(errs([lim(1), lim(0.5)])).toEqual(["buyOrder.lines.1.belowPercent"]);
		expect(errs([])).toEqual(["buyOrder.lines"]);
		expect(errs(Array.from({ length: 11 }, (_, i) => lim(i + 1)))).toEqual([
			"buyOrder.lines",
		]);
	});

	test("最大ロット数は 1〜10 の整数", () => {
		const errs = (maxPositions: number) =>
			validateConditionSet({
				...strategyTemplate("range").params,
				maxPositions,
			}).map((e) => e.path);
		expect(errs(1)).toEqual([]);
		expect(errs(10)).toEqual([]);
		expect(errs(0)).toEqual(["maxPositions"]);
		expect(errs(11)).toEqual(["maxPositions"]);
		expect(errs(1.5)).toEqual(["maxPositions"]);
	});

	test("ひな形は空以外は検証を通る", () => {
		for (const id of TEMPLATE_IDS) {
			const errs = validateConditionSet(strategyTemplate(id).params);
			expect(errs.map((e) => e.path)).toEqual(id === "blank" ? ["buy"] : []);
		}
	});
});

describe("emaPeriods / candleNeeds", () => {
	test("条件に出てくる EMA の本数と、必要な足の本数", () => {
		const p = strategyTemplate("trend").params;
		expect(emaPeriods(p)).toEqual([12, 48]);
		expect(candleNeeds(p)["1h"]).toBe(481);
	});

	test("ひな形を書き換えても次に取るひな形は変わらない", () => {
		strategyTemplate("trend").params.buy.conditions.length = 0;
		expect(strategyTemplate("trend").params.buy.conditions).toHaveLength(1);
	});
});

describe("parseConditionSet", () => {
	test("ひな形を JSON にして読み戻せる", () => {
		const p = strategyTemplate("trend").params;
		expect(parseConditionSet(JSON.parse(JSON.stringify(p)))).toEqual(p);
	});

	test("買いの注文方法が無ければ既定（指値 0.1% 下・3本）で読む", () => {
		const { buyOrder: _, ...old } = strategyTemplate("range").params;
		expect(
			parseConditionSet(JSON.parse(JSON.stringify(old)))?.buyOrder,
		).toEqual(DEFAULT_BUY_ORDER);
		expect(
			parseConditionSet({ ...old, buyOrder: { type: "stop" } }),
		).toBeNull();
	});

	test("行を持つ前の注文方法は1行として読み、最大ロット数が無ければ 1 で読む", () => {
		const { maxPositions: _, ...old } = strategyTemplate("range").params;
		const limit = parseConditionSet({
			...old,
			buyOrder: {
				type: "limit",
				belowPercent: 0.5,
				expireBars: 7,
				expireTimeframe: "1h",
			},
		});
		expect(limit?.buyOrder).toEqual({
			lines: [{ type: "limit", belowPercent: 0.5 }],
			expireBars: 7,
			expireTimeframe: "1h",
		});
		expect(limit?.maxPositions).toBe(1);
		expect(
			parseConditionSet({
				...old,
				buyOrder: {
					type: "market",
					belowPercent: 0.1,
					expireBars: 3,
					expireTimeframe: "1h",
				},
			})?.buyOrder,
		).toEqual(MARKET_BUY_ORDER);
	});

	test("トレンド追随のひな形だけ成行で買う", () => {
		const first = (id: TemplateId) =>
			strategyTemplate(id).params.buyOrder.lines[0]?.type;
		expect(first("trend")).toBe("market");
		expect(first("range")).toBe("limit");
		expect(first("blank")).toBe("limit");
	});

	test("形が違えば null", () => {
		expect(parseConditionSet(null)).toBeNull();
		expect(
			parseConditionSet({
				...params(),
				buy: { match: "all", conditions: [{ type: "unknown" }] },
			}),
		).toBeNull();
	});

	test("数値でない値は NaN にして検証で弾く", () => {
		const p = parseConditionSet({ ...params(), orderSize: "x" });
		expect(p?.orderSize).toBeNaN();
		expect(validateConditionSet(p as Flat).map((e) => e.path)).toContain(
			"orderSize",
		);
	});
});

describe("判定に使う足の粒度", () => {
	const withFreq = (
		timeframe: Timeframe,
		flat: string,
		holding: string,
	): Flat => {
		const f = (v: string) => ({
			value: Number(v.slice(0, -1)),
			unit: v.slice(-1) as "s" | "m" | "h",
		});
		const p = strategyTemplate("trend").params;
		const g = (x: Flat["buy"]) => ({
			...x,
			conditions: x.conditions.map((c) =>
				c.type === "emaCross" ? { ...c, timeframe } : c,
			),
		});
		return {
			...p,
			buy: g(p.buy),
			takeProfit: g(p.takeProfit),
			frequency: { flat: f(flat), holding: f(holding) },
		};
	};

	test.each([
		// 条件の足, 保有なし, あり, 最も細かいデータ, 期待する粒度, 足りないか
		["1h", "1h", "15m", "1m", "15m", false],
		["1h", "1h", "2h", "1m", "1h", false],
		["1h", "20m", "1h", "1m", "5m", false],
		["1d", "90m", "24h", "1m", "15m", false],
		["1h", "1h", "15m", "1h", "1h", true],
		["1h", "1h", "15m", "5m", "15m", false],
		["1h", "30s", "1h", "1m", "1m", true],
	] as const)(
		"%s・%s/%s・データ %s → %s（不足 %s）",
		(tf, flat, holding, finest, expected, limited) => {
			expect(chooseStepTimeframe(withFreq(tf, flat, holding), finest)).toEqual({
				timeframe: expected,
				limited,
			});
		},
	);

	test("指値があれば、取消を数える足より粗い足で進めない", () => {
		const p = withFreq("1h", "1h", "1h");
		const limit = {
			lines: [{ type: "limit" as const, belowPercent: 0.1 }],
			expireBars: 3,
			expireTimeframe: "5m" as const,
		};
		expect(chooseStepTimeframe({ ...p, buyOrder: limit }, "1m")).toEqual({
			timeframe: "5m",
			limited: false,
		});
		// 成行だけなら取消の足は見ない
		expect(
			chooseStepTimeframe({ ...p, buyOrder: MARKET_BUY_ORDER }, "1m"),
		).toEqual({ timeframe: "1h", limited: false });
	});
});

describe("市場評価の条件", () => {
	const bullish: Condition = {
		type: "judgment",
		judge: "sentiment",
		values: ["+1", "0"],
	};
	const judged = (label: string) => ({
		sentiment: [{ judge: "sentiment", time: 0, label }],
	});

	test("最新の判定が選んだ値のどれかなら成立し、理由に判定を書く", () => {
		const cs = candles([100, 100]);
		const hit = evaluateConditionSet(
			input(cs, buyWith(bullish), { judgments: judged("0") }),
		);
		expect(hit.intents).toHaveLength(1);
		expect(hit.note).toContain("センチメントが中立（やや強気・中立のどれか）");
		const miss = evaluateConditionSet(
			input(cs, buyWith(bullish), { judgments: judged("-1") }),
		);
		expect(miss.intents).toHaveLength(0);
	});

	test("判定がまだ無ければ、データなしを選んだ条件だけ成立する", () => {
		const out = evaluateConditionSet(input(candles([100]), buyWith(bullish)));
		expect(out.intents).toHaveLength(0);
		expect(out.note).toContain("買いの条件を満たさない");
		const withNone: Condition = {
			type: "judgment",
			judge: "sentiment",
			values: ["+1", "none"],
		};
		const hit = evaluateConditionSet(input(candles([100]), buyWith(withNone)));
		expect(hit.intents[0]).toMatchObject({ side: "buy" });
		expect(hit.note).toContain(
			"センチメントがデータなし（やや強気・データなしのどれか）",
		);
		// 判定があればデータなしは成立しない
		const neutral = evaluateConditionSet(
			input(candles([100]), buyWith(withNone), { judgments: judged("0") }),
		);
		expect(neutral.intents).toHaveLength(0);
		expect(acceptsNoJudgment(buyWith(withNone))).toBe(true);
		expect(acceptsNoJudgment(buyWith(bullish))).toBe(false);
		expect(
			validateConditionSet(buyWith(withNone)).filter((e) =>
				e.path.startsWith("buy."),
			),
		).toEqual([]);
	});

	test("売りのグループにも入れられる", () => {
		const p = params({
			stopLoss: {
				match: "any",
				conditions: [{ type: "judgment", judge: "risk", values: ["crisis"] }],
			},
		});
		const out = evaluateConditionSet(
			input(candles([100]), p, {
				position: holding(100),
				judgments: { risk: [{ judge: "risk", time: 0, label: "crisis" }] },
			}),
		);
		expect(out.intents[0]).toMatchObject({ side: "sell" });
	});

	test("使う判定器と入力検証", () => {
		const p = params({
			buy: {
				match: "all",
				conditions: [
					{ type: "judgment", judge: "sentiment", values: [] },
					{ type: "judgment", judge: "trend" as never, values: ["+1"] },
				],
			},
			stopLoss: {
				match: "any",
				conditions: [
					{
						type: "judgment",
						judge: "risk",
						values: ["crisis", "up" as never],
					},
				],
			},
		});
		expect(conditionStrategy.requiredJudges(p)).toEqual(["sentiment", "risk"]);
		// 統合で無くなったトレンドの判定器は受け付けない
		expect(validateConditionSet(p).map((e) => e.path)).toEqual([
			"buy.conditions.0.values",
			"buy.conditions.1.judge",
			"stopLoss.conditions.0.values",
		]);
	});
});

describe("複数ポジション", () => {
	const buyAlways: Condition = {
		type: "breakout",
		timeframe: "1h",
		lookback: 1,
		direction: "high",
	};
	const loss: Condition = {
		type: "entryChange",
		percent: 1,
		direction: "down",
	};
	const multi = (over: Partial<Flat> = {}) =>
		params({
			maxPositions: 3,
			buy: { match: "all", conditions: [buyAlways] },
			buyOrder: {
				lines: [
					{ type: "market" },
					{ type: "limit", belowPercent: 0.5 },
					{ type: "limit", belowPercent: 1 },
				],
				expireBars: 5,
				expireTimeframe: "1h",
			},
			stopLoss: { match: "any", conditions: [loss] },
			...over,
		});
	const rising = candles([10_000_000, 10_000_000]).map((c, i) =>
		i === 1 ? { ...c, close: 10_000_100 } : c,
	);
	const lot = (id: string, entryPrice: number) => ({
		id,
		quantity: 1_000_000,
		entryPrice,
		openedAt: 0,
	});

	test("1回の条件成立で行の数だけ同時に出す。指値は行ごとの %、期限は同じ本数", () => {
		const out = evaluateConditionSet(input(rising, multi()));
		expect(out.intents).toEqual([
			{
				kind: "place",
				side: "buy",
				buyId: "b1",
				type: "market",
				quantity: 1_000_000,
			},
			{
				kind: "place",
				side: "buy",
				buyId: "b1",
				type: "limit",
				price: 9_950_099,
				quantity: 1_000_000,
				expireAfterMs: 5 * H,
			},
			{
				kind: "place",
				side: "buy",
				buyId: "b1",
				type: "limit",
				price: 9_900_099,
				quantity: 1_000_000,
				expireAfterMs: 5 * H,
			},
		]);
		expect(out.state).toEqual({ buyHits: { b1: true } });
	});

	test("空き枠が行の数より少なければ、空きの数だけ先頭から出す。保有中でも買う", () => {
		const out = evaluateConditionSet(
			input(rising, multi(), { lots: [lot("b1", 10_000_000)] }),
		);
		expect(out.intents.map((i) => i.kind === "place" && i.type)).toEqual([
			"market",
			"limit",
		]);
	});

	test("最大ロット数に達していれば買わない", () => {
		const out = evaluateConditionSet(
			input(rising, multi({ maxPositions: 2 }), {
				lots: [lot("b1", 10_000_000), lot("b2", 10_000_000)],
			}),
		);
		expect(out.intents).toEqual([]);
		expect(out.note).toContain("最大ロット数 2 に達しているため買わない");
	});

	test("未約定の買いがあれば新しい買いを出さない", () => {
		const open: Order = {
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
			input(rising, multi(), { openOrders: [open] }),
		);
		expect(out.intents).toEqual([]);
		expect(out.note).toBe("買い注文の約定待ち");
	});

	test("最大ロット数が 2 以上なら、前回も条件が成立していたときは買わない（一度外れてから買う）", () => {
		const kept = evaluateConditionSet(
			input(rising, multi(), { state: { buyHit: true } }),
		);
		expect(kept.intents).toEqual([]);
		expect(kept.note).toContain("一度外れてから買う");
		const flat = candles([10_000_000, 10_000_000]);
		expect(
			evaluateConditionSet(input(flat, multi(), { state: { buyHit: true } }))
				.state,
		).toEqual({ buyHits: { b1: false } });
		expect(
			evaluateConditionSet(input(rising, multi(), { state: { buyHit: false } }))
				.intents,
		).toHaveLength(3);
	});

	test("最大ロット数が 1 なら前回の成立を見ず、state も変えない（今までどおり）", () => {
		const one = multi({ maxPositions: 1 });
		const out = evaluateConditionSet(
			input(rising, one, { state: { buyHit: true } }),
		);
		expect(out.intents).toHaveLength(1);
		expect(out.state).toEqual({ buyHits: { b1: true } });
	});

	test("売りはロットごとに、そのロットの買値からの % で判定し、ロットを指定して売る", () => {
		const out = evaluateConditionSet(
			input(candles([9_950_000]), multi(), {
				lots: [lot("b1", 10_100_000), lot("b2", 9_960_000)],
			}),
		);
		const sells = out.intents.filter(
			(i) => i.kind === "place" && i.side === "sell",
		);
		expect(sells).toEqual([
			{
				kind: "place",
				side: "sell",
				type: "market",
				quantity: 1_000_000,
				lotId: "b1",
				exitKind: "stopLoss",
			},
		]);
		expect(out.note).toContain(
			"買値 10,100,000 のロット 0.010 BTC を売却（損切りの条件）",
		);
	});

	test("売りが約定待ちのロットは判定しない", () => {
		const selling: Order = {
			id: "o9",
			side: "sell",
			type: "market",
			price: null,
			quantity: 1_000_000,
			placedAt: 0,
			expiresAt: null,
			status: "open",
			lotId: "b1",
		};
		const out = evaluateConditionSet(
			input(candles([9_000_000]), multi({ maxPositions: 2 }), {
				lots: [lot("b1", 10_000_000), lot("b2", 10_000_000)],
				openOrders: [selling],
			}),
		);
		expect(out.intents.map((i) => i.kind === "place" && i.lotId)).toEqual([
			"b2",
		]);
	});

	test("資金が足りなくなった行から先は出さない", () => {
		const out = evaluateConditionSet(input(rising, multi(), { cash: 150_000 }));
		expect(out.intents).toHaveLength(1);
		expect(out.note).toContain("残り 2 件は");
	});
});

describe("終値と EMA の位置", () => {
	const above: Condition = {
		type: "emaPosition",
		timeframe: "1h",
		period: 3,
		direction: "above",
	};

	test("終値が EMA より上なら成立し、値を記録に残す", () => {
		// EMA(3) の起点は [1,2,3] の平均 2、次は 10*0.5 + 2*0.5 = 6
		const out = evaluateConditionSet(
			input(candles([1, 2, 3, 10]), buyWith(above)),
		);
		expect(out.intents).toHaveLength(1);
		expect(out.note).toContain("終値 10 が1時間足のEMA(3) 6 より上");
	});

	test("等しければ成立しない。下も判定できる", () => {
		const flat = candles([5, 5, 5]);
		expect(
			evaluateConditionSet(input(flat, buyWith(above))).intents,
		).toHaveLength(0);
		expect(
			evaluateConditionSet(
				input(flat, buyWith({ ...above, direction: "below" })),
			).intents,
		).toHaveLength(0);
		expect(
			evaluateConditionSet(
				input(candles([5, 5, 5, 1]), buyWith({ ...above, direction: "below" })),
			).intents,
		).toHaveLength(1);
	});

	test("本数が足りない間は判定しない", () => {
		const out = evaluateConditionSet(input(candles([1, 2]), buyWith(above)));
		expect(out.note).toContain("EMA(3) に 3 本必要、現在 2 本");
	});

	test("チャートの EMA と必要な足の本数に含め、JSON から読み戻せる", () => {
		const p = buyWith({ ...above, period: 200 });
		expect(emaPeriods(p)).toEqual([200]);
		expect(candleNeeds(p)["1h"]).toBe(2001);
		expect(parseConditionSet(JSON.parse(JSON.stringify(p)))?.buy).toEqual(
			p.buy,
		);
	});

	test("本数は 2〜500 の整数", () => {
		const errs = validateConditionSet(
			params({
				buy: { match: "all", conditions: [{ ...above, period: 501 }] },
				stopLoss: { match: "any", conditions: [{ ...above, period: 1 }] },
			}),
		);
		expect(errs.map((e) => e.path)).toEqual([
			"buy.conditions.0.period",
			"stopLoss.conditions.0.period",
		]);
	});
});

describe("EMA の傾き", () => {
	const up: Condition = {
		type: "emaSlope",
		timeframe: "1h",
		period: 3,
		bars: 1,
		percent: 0,
		direction: "up",
	};

	test("EMA が N 本前より上がっていれば成立し、値を記録に残す", () => {
		// EMA(3) は [1,2,3] の平均 2 を起点に、次は 10*0.5 + 2*0.5 = 6。+200%
		const out = evaluateConditionSet(
			input(candles([1, 2, 3, 10]), buyWith(up)),
		);
		expect(out.intents).toHaveLength(1);
		expect(out.note).toContain("EMA(3) 6 は 1 本前 2 から +200.00%");
	});

	test("% 以上変わっていなければ成立しない", () => {
		const c = candles([1, 2, 3, 10]);
		expect(
			evaluateConditionSet(input(c, buyWith({ ...up, percent: 200 }))).intents,
		).toHaveLength(1);
		expect(
			evaluateConditionSet(input(c, buyWith({ ...up, percent: 200.01 })))
				.intents,
		).toHaveLength(0);
	});

	test("横ばいはどちらの向きでも成立しない。下がったも判定できる", () => {
		const down: Condition = { ...up, direction: "down" };
		const flat = candles([5, 5, 5, 5]);
		expect(evaluateConditionSet(input(flat, buyWith(up))).intents).toHaveLength(
			0,
		);
		expect(
			evaluateConditionSet(input(flat, buyWith(down))).intents,
		).toHaveLength(0);
		// EMA(3) は 5 → 3（1*0.5 + 5*0.5）で −40%
		const out = evaluateConditionSet(
			input(candles([5, 5, 5, 1]), buyWith({ ...down, percent: 40 })),
		);
		expect(out.intents).toHaveLength(1);
		expect(out.note).toContain("から −40.00%（−40% 以上）");
	});

	test("本数が足りない間は判定しない", () => {
		const out = evaluateConditionSet(input(candles([1, 2, 3]), buyWith(up)));
		expect(out.note).toContain("EMA(3) の 1 本前比に 4 本必要、現在 3 本");
	});

	test("チャートの EMA と必要な足の本数に含め、JSON から読み戻せる", () => {
		const p = buyWith({ ...up, period: 50, bars: 5, percent: 0.25 });
		expect(emaPeriods(p)).toEqual([50]);
		expect(candleNeeds(p)["1h"]).toBe(506);
		expect(parseConditionSet(JSON.parse(JSON.stringify(p)))?.buy).toEqual(
			p.buy,
		);
	});

	test("本数・比べる本数・% の範囲を検査する", () => {
		const errs = validateConditionSet(
			params({
				buy: {
					match: "all",
					conditions: [{ ...up, period: 1, bars: 0, percent: 0.001 }],
				},
				stopLoss: {
					match: "any",
					conditions: [{ ...up, bars: 501, percent: -1 }],
				},
			}),
		);
		expect(errs.map((e) => e.path)).toEqual([
			"buy.conditions.0.period",
			"buy.conditions.0.bars",
			"buy.conditions.0.percent",
			"stopLoss.conditions.0.bars",
			"stopLoss.conditions.0.percent",
		]);
	});
});

describe("ボリンジャーバンド", () => {
	const lower: Condition = {
		type: "bollinger",
		timeframe: "1h",
		period: 3,
		sigma: 1,
		band: "lower",
	};

	test("終値が下限以下なら成立し、値を記録に残す", () => {
		// [10,10,4] 平均 8、母標準偏差 sqrt(8)≈2.83、下限 ≈5.17
		const out = evaluateConditionSet(
			input(candles([10, 10, 4]), buyWith(lower)),
		);
		expect(out.intents).toHaveLength(1);
		expect(out.note).toContain(
			"終値 4 が1時間足のボリンジャーバンド(3本・1σ)の下限",
		);
	});

	test("上限以上。幅が 0 ならちょうどでも成立する", () => {
		const upper: Condition = { ...lower, band: "upper" };
		expect(
			evaluateConditionSet(input(candles([4, 10, 10]), buyWith(upper))).intents,
		).toHaveLength(0);
		expect(
			evaluateConditionSet(input(candles([10, 4, 16]), buyWith(upper))).intents,
		).toHaveLength(1);
		expect(
			evaluateConditionSet(input(candles([5, 5, 5]), buyWith(upper))).intents,
		).toHaveLength(1);
	});

	test("本数が足りない間は判定しない", () => {
		const out = evaluateConditionSet(input(candles([1, 2]), buyWith(lower)));
		expect(out.note).toContain("ボリンジャーバンド(3) に 3 本必要");
	});

	test("本数は 2〜500 の整数、σ は 0.1〜5 の 0.1 刻み", () => {
		const errs = validateConditionSet(
			params({
				buy: {
					match: "all",
					conditions: [
						{ ...lower, period: 1 },
						{ ...lower, sigma: 0.15 },
						{ ...lower, sigma: 5.1 },
						{ ...lower, period: 500, sigma: 2.5 },
					],
				},
				stopLoss: { match: "any", conditions: [lower] },
			}),
		);
		expect(errs.map((e) => e.path)).toEqual([
			"buy.conditions.0.period",
			"buy.conditions.1.sigma",
			"buy.conditions.2.sigma",
		]);
	});

	test("必要な足の本数は期間の本数。JSON から読み戻せる", () => {
		const p = buyWith({ ...lower, period: 20 });
		expect(candleNeeds(p)["1h"]).toBe(20);
		expect(parseConditionSet(JSON.parse(JSON.stringify(p)))?.buy).toEqual(
			p.buy,
		);
	});
});

describe("トレーリングストップ", () => {
	const trail: Condition = {
		type: "trailingStop",
		percent: 3,
		activatePercent: 0,
	};
	const sellOn = (c: Condition) =>
		params({ stopLoss: { match: "any", conditions: [c] } });
	const bar = (i: number, high: number, close: number): Candle => ({
		time: i * H,
		open: close,
		high,
		low: close,
		close,
		volume: 0,
	});
	const lot = (openedAt: number) => ({
		id: "b1",
		quantity: 1_000_000,
		entryPrice: 100,
		openedAt,
	});

	test("約定より後の足の高値から % 下がったら売る", () => {
		const cs = [bar(0, 100, 100), bar(1, 110, 108), bar(2, 107, 106)];
		const out = evaluateConditionSet(
			input(cs, sellOn(trail), { lots: [lot(1 * H - 1)] }),
		);
		expect(out.intents).toHaveLength(1);
		expect(out.note).toContain("買ってからの最高値 110 から −3.6%");
		expect(out.state).toEqual({ peaks: { b1: 110 } });
	});

	test("約定した足は約定前の高値を含みうるので終値だけ見る", () => {
		// 約定は2本目の途中。2本目の高値 200 は約定前のものとみなす
		const cs = [bar(0, 100, 100), bar(1, 200, 104), bar(2, 104, 101)];
		const out = evaluateConditionSet(
			input(cs, sellOn(trail), { lots: [lot(1 * H + 1)] }),
		);
		expect(out.intents).toHaveLength(0);
		expect(out.state).toEqual({ peaks: { b1: 104 } });
	});

	test("約定時刻が足の開始時刻と同じ（バックテスト）なら、その足も約定した足として終値だけ見る", () => {
		const cs = [bar(0, 100, 100), bar(1, 110, 100), bar(2, 101, 100)];
		const out = evaluateConditionSet(
			input(cs, sellOn(trail), { lots: [lot(1 * H)] }),
		);
		expect(out.intents).toHaveLength(0);
		expect(out.state).toEqual({ peaks: { b1: 101 } });
	});

	test("前回までの最高値を state で引き継ぐ。売ったロットは消える", () => {
		const cs = [bar(5, 101, 101)];
		const out = evaluateConditionSet(
			input(cs, sellOn(trail), {
				lots: [lot(0)],
				state: { buyHit: false, peaks: { b1: 120, old: 999 } },
			}),
		);
		expect(out.intents).toHaveLength(1);
		expect(out.state).toEqual({
			buyHits: { b1: false },
			peaks: { b1: 120 },
		});
	});

	test("最高値が買値を下回ることはない", () => {
		const cs = [bar(1, 98, 97)];
		const out = evaluateConditionSet(
			input(cs, sellOn(trail), { lots: [lot(1 * H)] }),
		);
		expect(out.intents).toHaveLength(1);
		expect(out.note).toContain("最高値 100 から −3.0%");
	});

	test("使わない戦略では state を増やさない", () => {
		const out = evaluateConditionSet(
			input(
				candles([100]),
				sellOn({ type: "holdingBars", timeframe: "1h", bars: 99 }),
				{
					lots: [lot(0)],
				},
			),
		);
		expect(out.state).toBeNull();
	});

	test("前回の判定から今回までの足をすべて受け取る", () => {
		const p = params({
			frequency: {
				flat: { value: 1, unit: "m" },
				holding: { value: 1, unit: "h" },
			},
			stopLoss: { match: "any", conditions: [trail] },
		});
		expect(recentMs(p)).toBe(H);
		expect(recentMs(buyWith())).toBe(0);
	});

	test("売りのグループだけで使え、% は 0.1〜100", () => {
		const errs = validateConditionSet(
			params({
				buy: { match: "all", conditions: [trail] },
				stopLoss: { match: "any", conditions: [{ ...trail, percent: 0 }] },
			}),
		);
		expect(errs.map((e) => e.path)).toEqual([
			"buy.conditions.0",
			"stopLoss.conditions.0.percent",
		]);
	});
});

describe("買ってからの本数", () => {
	const hold: Condition = { type: "holdingBars", timeframe: "1h", bars: 3 };
	const sellOn = params({ takeProfit: { match: "any", conditions: [hold] } });
	const lot = { id: "b1", quantity: 1_000_000, entryPrice: 100, openedAt: 0 };

	test("約定から条件の足で N 本経ったら売る", () => {
		const at = (now: number) =>
			evaluateConditionSet(input(candles([100]), sellOn, { lots: [lot], now }));
		expect(at(3 * H - 1).intents).toHaveLength(0);
		const out = at(3 * H);
		expect(out.intents).toHaveLength(1);
		expect(out.note).toContain("買ってから1時間足で 3 本経過（3 本以上）");
		const daily = params({
			takeProfit: {
				match: "any",
				conditions: [{ ...hold, timeframe: "1d", bars: 1 }],
			},
		});
		const d = (now: number) =>
			evaluateConditionSet(input(candles([100]), daily, { lots: [lot], now }));
		expect(d(24 * H - 1).intents).toHaveLength(0);
		expect(d(24 * H).intents).toHaveLength(1);
	});

	test("売りのグループだけで使え、本数は 1〜1000 の整数。JSON から読み戻せる", () => {
		const errs = validateConditionSet(
			params({
				buy: { match: "all", conditions: [hold] },
				stopLoss: { match: "any", conditions: [{ ...hold, bars: 1001 }] },
			}),
		);
		expect(errs.map((e) => e.path)).toEqual([
			"buy.conditions.0",
			"stopLoss.conditions.0.bars",
		]);
		expect(
			parseConditionSet(JSON.parse(JSON.stringify(sellOn)))?.takeProfit,
		).toEqual(sellOn.takeProfit);
	});
});

describe("トレーリングストップの発動", () => {
	const trail: Condition = {
		type: "trailingStop",
		percent: 3,
		activatePercent: 5,
	};
	const p = params({ takeProfit: { match: "any", conditions: [trail] } });
	const lot = { id: "b1", quantity: 1_000_000, entryPrice: 100, openedAt: 0 };

	test("最高値が買値から発動の % に届くまでは成立しない", () => {
		const out = evaluateConditionSet(
			input(candles([100]), p, { lots: [lot], state: { peaks: { b1: 104 } } }),
		);
		expect(out.intents).toHaveLength(0);
	});

	test("一度届けば、その後に買値近くまで戻っても成立する", () => {
		const out = evaluateConditionSet(
			input(candles([101]), p, { lots: [lot], state: { peaks: { b1: 106 } } }),
		);
		expect(out.intents).toHaveLength(1);
		expect(out.note).toContain("最高値が買値から +5% 以上になってから発動");
	});

	test("発動の % は 0〜100、0.1 刻み。持たない保存済みの条件は 0 として読む", () => {
		const errs = validateConditionSet(
			params({
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
				stopLoss: {
					match: "any",
					conditions: [{ ...trail, activatePercent: 0.05 }],
				},
			}),
		);
		expect(errs.map((e) => e.path)).toEqual([
			"stopLoss.conditions.0.activatePercent",
		]);
		const legacy = JSON.parse(JSON.stringify(p));
		legacy.takeProfit.conditions[0] = { type: "trailingStop", percent: 3 };
		expect(parseConditionSet(legacy)?.takeProfit.conditions[0]).toEqual({
			type: "trailingStop",
			percent: 3,
			activatePercent: 0,
		});
	});
});

describe("一部利確", () => {
	const up = (percent: number): Condition => ({
		type: "entryChange",
		percent,
		direction: "up",
	});
	const down: Condition = {
		type: "entryChange",
		percent: 5,
		direction: "down",
	};
	const p = params({
		partialTakeProfit: { match: "all", conditions: [up(8)] },
		takeProfit: { match: "any", conditions: [up(20)] },
		stopLoss: { match: "any", conditions: [down] },
	});
	const lot = (partialExitDone = false) => ({
		id: "b1",
		quantity: 1_000_000,
		entryPrice: 100,
		openedAt: 0,
		partialExitDone,
	});
	const sellOf = (out: ReturnType<typeof evaluateConditionSet>) =>
		out.intents.map((i) =>
			i.kind === "place" ? [i.quantity, i.exitKind] : null,
		);

	test("成立したらロットの割合ぶんだけ一部利確として売る", () => {
		const out = evaluateConditionSet(
			input(candles([110]), p, { lots: [lot()] }),
		);
		expect(sellOf(out)).toEqual([[500_000, "partialTakeProfit"]]);
		expect(out.note).toContain(
			"保有中の 0.010 BTC のうち 0.005 BTC を売却（一部利確の条件）",
		);
	});

	test("1ロットにつき1回だけ。済んだロットには利確・損切りだけが効く", () => {
		expect(
			sellOf(
				evaluateConditionSet(input(candles([110]), p, { lots: [lot(true)] })),
			),
		).toEqual([]);
		expect(
			sellOf(
				evaluateConditionSet(input(candles([125]), p, { lots: [lot(true)] })),
			),
		).toEqual([[1_000_000, "takeProfit"]]);
	});

	test("利確と同時に成り立てば利確で全量を売る", () => {
		expect(
			sellOf(evaluateConditionSet(input(candles([130]), p, { lots: [lot()] }))),
		).toEqual([[1_000_000, "takeProfit"]]);
	});

	test("建値ストップ: 一部利確の後に買値を下回ったら、残りを損切りとして売る", () => {
		const out = evaluateConditionSet(
			input(candles([99]), p, { lots: [lot(true)] }),
		);
		expect(sellOf(out)).toEqual([[1_000_000, "stopLoss"]]);
		expect(out.note).toContain("一部利確の後、現在値 99 が買値 100 を下回った");
		// 一部利確の前と、建値ストップを使わない戦略では効かない
		expect(
			sellOf(evaluateConditionSet(input(candles([99]), p, { lots: [lot()] }))),
		).toEqual([]);
		const off = { ...p, partialSell: { percent: 50, breakevenStop: false } };
		expect(
			sellOf(
				evaluateConditionSet(input(candles([99]), off, { lots: [lot(true)] })),
			),
		).toEqual([]);
	});

	test("売る量と残りがどちらも最小の注文量以上になる割合だけ保存できる", () => {
		const buy = {
			match: "all" as const,
			conditions: [
				{
					type: "rsi",
					timeframe: "1h",
					period: 14,
					threshold: 30,
					direction: "below",
				} as const,
			],
		};
		const at = (orderSize: number, percent: number) =>
			validateConditionSet({
				...p,
				buy,
				orderSize,
				partialSell: { percent, breakevenStop: true },
			}).map((e) => e.path);
		expect(at(250_000, 50)).toEqual([]);
		expect(at(150_000, 50)).toEqual(["partialSell.percent"]);
		expect(at(250_000, 100)).toEqual(["partialSell.percent"]);
		// 一部利確の条件が空なら量は見ない
		expect(
			validateConditionSet({
				...p,
				buy,
				orderSize: 100_000,
				partialTakeProfit: { match: "all", conditions: [] },
			}),
		).toEqual([]);
	});

	test("持たない保存済みの戦略は、一部利確の条件を空として読む", () => {
		const legacy = JSON.parse(JSON.stringify(p));
		delete legacy.partialTakeProfit;
		delete legacy.partialSell;
		const read = parseConditionSet(legacy);
		expect(read?.partialTakeProfit).toEqual({ match: "all", conditions: [] });
		expect(read?.partialSell).toEqual(DEFAULT_PARTIAL_SELL);
	});
});

describe("RSI のクロス", () => {
	const up: Condition = {
		type: "rsiCross",
		timeframe: "1h",
		period: 2,
		threshold: 30,
		bars: 1,
		direction: "up",
	};

	test("前の足でしきい値未満、今の足でしきい値以上なら上抜け", () => {
		// RSI(2): 0 → 66.7
		const out = evaluateConditionSet(
			input(candles([100, 90, 80, 100]), buyWith(up)),
		);
		expect(out.intents).toHaveLength(1);
		expect(out.note).toContain("RSI(2) が 30 を上抜け（前の足 0.0 → 今 66.7）");
	});

	test("前の足でもしきい値以上なら成立しない", () => {
		// RSI(2): 100 → 100
		const out = evaluateConditionSet(
			input(candles([100, 110, 120, 130]), buyWith(up)),
		);
		expect(out.intents).toHaveLength(0);
	});

	test("直近 M 本以内に抜けていれば成立する", () => {
		// RSI(2): 0 → 66.7 → 80。抜けたのは1本前
		const cs = candles([100, 90, 80, 100, 110]);
		expect(evaluateConditionSet(input(cs, buyWith(up))).intents).toHaveLength(
			0,
		);
		const out = evaluateConditionSet(input(cs, buyWith({ ...up, bars: 2 })));
		expect(out.intents).toHaveLength(1);
		expect(out.note).toContain("RSI(2) が 1 本前に 30 を上抜け（今 80.0）");
	});

	test("下抜け", () => {
		// RSI(2): 100 → 33.3
		const out = evaluateConditionSet(
			input(
				candles([100, 110, 120, 100]),
				buyWith({ ...up, threshold: 70, direction: "down" }),
			),
		);
		expect(out.note).toContain("RSI(2) が 70 を下抜け");
	});

	test("本数が足りない間は判定しない", () => {
		const out = evaluateConditionSet(
			input(candles([100, 90, 80]), buyWith(up)),
		);
		expect(out.intents).toHaveLength(0);
		expect(out.note).toContain("RSI(2) のクロスに 4 本必要");
	});

	test("期間・しきい値・本数の範囲", () => {
		const errs = validateConditionSet(
			buyWith({ ...up, period: 1, threshold: 100, bars: 0 }),
		).map((e) => e.path);
		expect(errs).toContain("buy.conditions.0.period");
		expect(errs).toContain("buy.conditions.0.threshold");
		expect(errs).toContain("buy.conditions.0.bars");
		expect(
			validateConditionSet(
				buyWith({ ...up, period: 100, threshold: 99, bars: 100 }),
			).filter((e) => e.path.startsWith("buy.conditions")),
		).toEqual([]);
	});

	test("チャートの RSI と必要な足の本数に含め、JSON から読み戻せる", () => {
		const p = buyWith({ ...up, period: 14, bars: 3 });
		expect(rsiLines(p)).toEqual([{ period: 14, thresholds: [30] }]);
		expect(candleNeeds(p)["1h"]).toBe(144);
		expect(parseConditionSet(JSON.parse(JSON.stringify(p)))).toEqual(p);
	});
});

describe("損切り後に買わない本数", () => {
	const always: Condition = {
		type: "breakout",
		timeframe: "1h",
		lookback: 2,
		direction: "high",
	};
	const loss: Condition = {
		type: "entryChange",
		percent: 2,
		direction: "down",
	};
	const p = params({
		maxPositions: 2,
		stopLossCooldownBars: 3,
		buy: { match: "all", conditions: [always] },
		stopLoss: { match: "any", conditions: [loss] },
	});
	// 終値が直近2本の最高値を上抜け続ける並び
	const rising = candles([90, 95, 98]);

	test("損切りした判定では、空き枠があっても買わない。損切りの時刻を state に残す", () => {
		const out = evaluateConditionSet(
			input(rising, p, { position: holding(100) }),
		);
		expect(
			out.intents.map((i) => (i.kind === "place" ? i.side : null)),
		).toEqual(["sell"]);
		expect(out.note).toContain(
			"損切りから1時間足で 3 本経っていないため買わない（あと 3 本）",
		);
		expect(out.state).toMatchObject({ stopLossAt: 3 * H });
	});

	test("N 本ぶんの時間が経つまで買わず、経ったら買う", () => {
		const state = { stopLossAt: 0 };
		const at = (now: number) =>
			evaluateConditionSet(input(rising, p, { now, state }));
		const before = at(3 * H - 1);
		expect(before.intents).toHaveLength(0);
		expect(before.note).toContain("（あと 1 本）");
		expect(before.state).toMatchObject({ stopLossAt: 0 });
		expect(at(3 * H).intents).toHaveLength(1);
	});

	test("建値ストップも損切りとして数え、利確では止めない", () => {
		const out = evaluateConditionSet(
			input(rising, p, {
				lots: [
					{
						id: "b1",
						quantity: 1_000_000,
						entryPrice: 99,
						openedAt: 0,
						partialExitDone: true,
					},
				],
			}),
		);
		expect(out.note).toContain("一部利確の後");
		expect(out.state).toMatchObject({ stopLossAt: 3 * H });
		const tp = evaluateConditionSet(
			input(
				rising,
				{
					...p,
					takeProfit: {
						match: "any",
						conditions: [{ type: "entryChange", percent: 2, direction: "up" }],
					},
				},
				{ position: holding(90) },
			),
		);
		expect(tp.note).toContain("（利確の条件）");
		expect(
			tp.intents.filter((i) => i.kind === "place" && i.side === "buy"),
		).toHaveLength(1);
		expect(tp.state).not.toHaveProperty("stopLossAt");
	});

	test("0 なら止めず、state も変えない", () => {
		const off = { ...p, maxPositions: 1, stopLossCooldownBars: 0 };
		const out = evaluateConditionSet(
			input(rising, off, { state: { stopLossAt: 0 } }),
		);
		expect(out.intents).toHaveLength(1);
		expect(out.state).toBeNull();
	});

	test("0〜1000 の整数。持たない保存済みの戦略は 0 で読む", () => {
		const errs = (n: number) =>
			validateConditionSet({ ...p, stopLossCooldownBars: n }).map(
				(e) => e.path,
			);
		expect(errs(-1)).toContain("stopLossCooldownBars");
		expect(errs(1001)).toContain("stopLossCooldownBars");
		expect(errs(1.5)).toContain("stopLossCooldownBars");
		expect(errs(1000)).not.toContain("stopLossCooldownBars");
		const legacy = JSON.parse(JSON.stringify(p));
		delete legacy.stopLossCooldownBars;
		expect(parseConditionSet(legacy)?.stopLossCooldownBars).toBe(0);
	});
});

describe("条件ごとの足", () => {
	const D = TIMEFRAME_MS["1d"];
	const daily = (closes: number[]): Candle[] =>
		candles(closes).map((c, i) => ({ ...c, time: i * D }));
	const above = (timeframe: Timeframe): Condition => ({
		type: "emaPosition",
		timeframe,
		period: 3,
		direction: "above",
	});

	test("条件はその足で計算する。足ごとに別の足を見る", () => {
		const p = buyWith(above("1d"), above("1h"));
		const base = input(candles([1, 2, 3, 10]), p);
		// 日足が上がっていれば、終値 10 は日足の EMA(3) より上
		const hit = evaluateConditionSet({
			...base,
			candles: { ...base.candles, "1d": daily([1, 2, 10]) },
		});
		expect(hit.intents).toHaveLength(1);
		expect(hit.note).toContain("1時間足のEMA(3)");
		expect(hit.note).toContain("日足のEMA(3)");
		// 日足が下がっていれば、終値 10 は日足の EMA(3) より下で成立しない
		const miss = evaluateConditionSet({
			...base,
			candles: { ...base.candles, "1d": daily([30, 20, 10]) },
		});
		expect(miss.intents).toHaveLength(0);
	});

	test("期間の頭で足りない本数を、足ごとに最も多く要る条件で数える", () => {
		const p = buyWith(above("1d"), {
			type: "emaCross",
			timeframe: "1h",
			fast: 2,
			slow: 5,
			direction: "up",
		});
		const H = TIMEFRAME_MS["1h"];
		const from = 10 * D;
		// 日足は期間の前に 1 本（EMA(3) には途中の足を含めて 3 本要るので 1 本足りない）。1時間足は 5 本前からあるので足りる
		expect(
			historyShortfalls(p, from, { "1d": from - D, "1h": from - 5 * H }),
		).toEqual([{ timeframe: "1d", missing: 1 }]);
		// 足が無ければ途中の足を除いた全部が足りない
		expect(historyShortfalls(p, from, {})).toEqual([
			{ timeframe: "1h", missing: 5 },
			{ timeframe: "1d", missing: 2 },
		]);
	});

	test("その足が渡されていなければ本数不足として判定しない", () => {
		const out = evaluateConditionSet(
			input(candles([1, 2, 3, 10]), buyWith(above("1d"))),
		);
		expect(out.note).toContain("日足のEMA(3) に 3 本必要、現在 0 本");
	});

	test("必要な足を粒度ごとに求める。買ってからの本数は足を使わない", () => {
		const p = params({
			buy: { match: "all", conditions: [above("1d"), above("1h")] },
			takeProfit: {
				match: "any",
				conditions: [
					{ type: "breakout", timeframe: "4h", lookback: 5, direction: "high" },
					{ type: "holdingBars", timeframe: "5m", bars: 3 },
				],
			},
		});
		expect(candleNeeds(p)).toEqual({ "1d": 31, "1h": 31, "4h": 6 });
		expect(candleTimeframes(p)).toEqual(["1h", "4h", "1d"]);
	});

	test("足が選ばれていなければ入力エラー", () => {
		const bad = { ...above("1h"), timeframe: "2h" } as unknown as Condition;
		expect(validateConditionSet(buyWith(bad)).map((e) => e.path)).toContain(
			"buy.conditions.0.timeframe",
		);
		expect(
			validateConditionSet(
				params({
					buy: { match: "all", conditions: [above("1h")] },
					buyOrder: { ...DEFAULT_BUY_ORDER, expireTimeframe: "x" as Timeframe },
					stopLossCooldownTimeframe: "y" as Timeframe,
				}),
			).map((e) => e.path),
		).toEqual(
			expect.arrayContaining([
				"buyOrder.expireTimeframe",
				"stopLossCooldownTimeframe",
			]),
		);
	});

	test("戦略が足の粒度を1つだけ持っていた頃の形は、条件・指値・損切り後の足をその粒度で読む", () => {
		const { stopLossCooldownTimeframe: _, ...p } = params({
			buy: { match: "all", conditions: [above("1h")] },
			takeProfit: {
				match: "any",
				conditions: [{ type: "holdingBars", timeframe: "1h", bars: 3 }],
			},
		});
		const strip = (x: unknown) =>
			JSON.parse(JSON.stringify(x), (k, v) =>
				k === "timeframe" ? undefined : v,
			);
		const old = {
			...strip(p),
			timeframe: "4h",
			buyOrder: {
				lines: [{ type: "limit", belowPercent: 0.1 }],
				expireBars: 3,
			},
		};
		const read = parseConditionSet(old) as Flat;
		expect(read.buy.conditions[0]).toEqual({ ...above("4h") });
		expect(read.takeProfit.conditions[0]).toEqual({
			type: "holdingBars",
			timeframe: "4h",
			bars: 3,
		});
		expect(read.buyOrder.expireTimeframe).toBe("4h");
		expect(read.stopLossCooldownTimeframe).toBe("4h");
		expect(
			validateConditionSet(read).filter((e) => e.path !== "stopLoss"),
		).toEqual([]);
	});

	test("指値の取消までの時間は、指値の足の本数ぶん", () => {
		const out = evaluateConditionSet(
			input(
				candles([1, 2, 3, 10]),
				params({
					buy: { match: "all", conditions: [above("1h")] },
					buyOrder: {
						...DEFAULT_BUY_ORDER,
						expireBars: 2,
						expireTimeframe: "1d",
					},
				}),
			),
		);
		expect(out.intents[0]).toMatchObject({ expireAfterMs: 2 * D });
		expect(out.note).toContain("日足で 2 本のあいだ約定しなければ取消");
	});
});

describe("複数の買い", () => {
	const judged = (
		...values: ("+2" | "+1" | "0" | "-1" | "-2" | "none")[]
	): Flat["buy"] => ({
		match: "all",
		conditions: [{ type: "judgment", judge: "sentiment", values }],
	});
	const rule = (
		id: string,
		name: string,
		over: Partial<ConditionSet["buys"][number]> = {},
	): ConditionSet["buys"][number] => {
		const { frequency: _f, ...base } = params({
			buy: judged("+2", "+1", "0", "-1", "-2", "none"),
			buyOrder: MARKET_BUY_ORDER,
			stopLoss: {
				match: "any",
				conditions: [{ type: "entryChange", percent: 10, direction: "down" }],
			},
		});
		const {
			dailyLossLimit: _d,
			stopLossCooldownBars: _c,
			stopLossCooldownTimeframe: _t,
			...body
		} = base;
		return { id, name, ...body, ...over };
	};
	const set = (...buys: ConditionSet["buys"]): ConditionSet => ({
		...singleBuy(params()),
		buys,
	});
	const cs = candles([100, 100]);

	test("同時に成立したら上の買いだけ注文し、注文に買いの id と名前を付ける", () => {
		const out = evaluateConditionSet(
			input(cs, set(rule("b1", "押し目"), rule("b2", "突破"))),
		);
		expect(out.intents).toEqual([
			{
				kind: "place",
				side: "buy",
				type: "market",
				quantity: 1_000_000,
				buyId: "b1",
				buyName: "押し目",
			},
		]);
		expect(out.note).toContain("【押し目】");
		expect(out.note).toContain(
			"【突破】買いの条件を満たすが、上の「押し目」で注文したため買わない",
		);
	});

	test("上の買いが最大ロット数に達していれば、下の買いで注文する。注文量は買いごと", () => {
		const out = evaluateConditionSet(
			input(
				cs,
				set(rule("b1", "押し目"), rule("b2", "突破", { orderSize: 2_000_000 })),
				{
					lots: [
						{
							id: "o1",
							quantity: 1_000_000,
							entryPrice: 100,
							openedAt: 0,
							buyId: "b1",
						},
					],
				},
			),
		);
		expect(out.intents).toMatchObject([
			{ side: "buy", quantity: 2_000_000, buyId: "b2", buyName: "突破" },
		]);
	});

	test("買いの未約定の注文はその買いだけを止める", () => {
		const open: Order = {
			id: "o1",
			side: "buy",
			type: "limit",
			price: 90,
			quantity: 1_000_000,
			placedAt: 0,
			expiresAt: null,
			status: "open",
			buyId: "b1",
		};
		const out = evaluateConditionSet(
			input(cs, set(rule("b1", "押し目"), rule("b2", "突破")), {
				openOrders: [open],
			}),
		);
		expect(out.note).toContain("【押し目】買い注文の約定待ち");
		expect(out.intents).toMatchObject([{ buyId: "b2" }]);
	});

	test("ロットは買った買いの売りの条件で売る。買いを持たないロットは先頭の買いで売る", () => {
		const p = set(
			rule("b1", "押し目", {
				buy: judged("+2"),
				takeProfit: {
					match: "any",
					conditions: [{ type: "entryChange", percent: 50, direction: "up" }],
				},
			}),
			rule("b2", "突破", {
				buy: judged("+2"),
				takeProfit: {
					match: "any",
					conditions: [{ type: "entryChange", percent: 5, direction: "up" }],
				},
			}),
		);
		// 買値 90 から 100 は +11%: 突破（5%）では利確、押し目（50%）では売らない
		const lots = [
			{
				id: "o1",
				quantity: 1_000_000,
				entryPrice: 90,
				openedAt: 0,
				buyId: "b1",
			},
			{
				id: "o2",
				quantity: 1_000_000,
				entryPrice: 90,
				openedAt: 0,
				buyId: "b2",
			},
			{ id: "o3", quantity: 1_000_000, entryPrice: 90, openedAt: 0 },
		];
		const out = evaluateConditionSet(input(cs, p, { lots }));
		expect(out.intents).toEqual([
			{
				kind: "place",
				side: "sell",
				type: "market",
				quantity: 1_000_000,
				lotId: "o2",
				exitKind: "takeProfit",
			},
		]);
		expect(out.note).toContain("「突破」で買った買値 90 のロット");
	});

	test("連続買いの防止は買いごとに数える", () => {
		const p = set(
			rule("b1", "押し目", { maxPositions: 2 }),
			rule("b2", "突破", { maxPositions: 2 }),
		);
		const out = evaluateConditionSet(
			input(cs, p, { state: { buyHits: { b1: true } } }),
		);
		expect(out.note).toContain("【押し目】買いの条件が続いているため買わない");
		expect(out.intents).toMatchObject([{ buyId: "b2" }]);
		expect(out.state).toEqual({ buyHits: { b1: true, b2: true } });
	});

	test("入力検証: 買いは1〜5個、名前は1〜20文字で重ならない、項目のパスは買いの番号から", () => {
		const errs = (p: ConditionSet) => validateConditionSetOf(p);
		expect(errs(set(rule("b1", "押し目"), rule("b2", "突破")))).toEqual([]);
		expect(errs(set())).toContainEqual({
			path: "buys",
			message: "買いは 1〜5 個にする",
		});
		expect(
			errs(set(...[1, 2, 3, 4, 5, 6].map((i) => rule(`b${i}`, `買い${i}`)))),
		).toContainEqual({ path: "buys", message: "買いは 1〜5 個にする" });
		expect(errs(set(rule("b1", "押し目"), rule("b2", " 押し目 ")))).toEqual([
			{ path: "buys.1.name", message: "ほかの買いと違う名前にする" },
		]);
		expect(errs(set(rule("b1", " ")))).toEqual([
			{ path: "buys.0.name", message: "1〜20 文字で入れる" },
		]);
		expect(errs(set(rule("b1", "押し目"), rule("b1", "突破")))).toEqual([
			{ path: "buys.1", message: "買いの id が重なっている" },
		]);
		expect(
			errs(set(rule("b1", "押し目"), rule("b2", "突破", { orderSize: 1 }))),
		).toMatchObject([{ path: "buys.1.orderSize" }]);
	});

	test("JSON から読み戻せる。買いを持たない保存済みの戦略は買い1つ（b1・買い1）として読む", () => {
		const p = set(rule("b1", "押し目"), rule("b3", "突破"));
		expect(parseConditionSetOf(JSON.parse(JSON.stringify(p)))).toEqual(p);
		const legacy = params({ buy: judged("+2") });
		const read = parseConditionSetOf(JSON.parse(JSON.stringify(legacy)));
		expect(read?.buys).toHaveLength(1);
		expect(read?.buys[0]).toMatchObject({
			id: "b1",
			name: "買い1",
			buy: judged("+2"),
		});
		expect(parseConditionSetOf({ ...p, buys: [{ id: 1 }] })).toBeNull();
	});
});
