import { describe, expect, test } from "bun:test";
import type {
	BuyOrderLine,
	Condition,
	ConditionSet,
} from "./condition-strategy";
import {
	acceptsNoJudgment,
	chooseStepTimeframe,
	conditionStrategy,
	DEFAULT_BUY_ORDER,
	emaPeriods,
	evaluateConditionSet,
	historyBars,
	MARKET_BUY_ORDER,
	parseConditionSet,
	rsiLines,
	validateConditionSet,
} from "./condition-strategy";
import type { StrategyInput } from "./strategy";
import type { TemplateId } from "./templates";
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
		maxPositions: 1,
		dailyLossLimit: 30_000,
		buy: { match: "all", conditions: [] },
		buyOrder: DEFAULT_BUY_ORDER,
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
	const position = over.position ?? EMPTY_POSITION;
	return {
		now: ((cs.at(-1)?.time ?? 0) as number) + H,
		candles: cs,
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

describe("RSI", () => {
	const below: Condition = {
		type: "rsi",
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
		expect(historyBars(buyWith({ ...below, period: 14 }))).toBe(141);
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

	test("値幅と取消までの本数は戦略の設定に従う", () => {
		const out = evaluateConditionSet(
			input(rising, {
				...always,
				buyOrder: {
					lines: [{ type: "limit", belowPercent: 1.25 }],
					expireBars: 10,
				},
			}),
		);
		// 13,500,005 × 98.75% = 13,331,254.9... → 13,331,254
		expect(out.intents).toEqual([
			{
				kind: "place",
				side: "buy",
				type: "limit",
				price: 13_331_254,
				quantity: 1_000_000,
				expireAfterBars: 10,
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
			{ kind: "place", side: "buy", type: "market", quantity: 1_000_000 },
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
				dailyLossLimit: 30_000,
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
		const errs = (buyOrder: ConditionSet["buyOrder"]) =>
			validateConditionSet({
				...strategyTemplate("range").params,
				buyOrder,
			}).map((e) => e.path);
		const limit = (belowPercent: number, expireBars = 3) =>
			errs({ lines: [{ type: "limit", belowPercent }], expireBars });
		expect(limit(0)).toEqual([]);
		expect(limit(99.99, 100)).toEqual([]);
		expect(limit(100)).toEqual(["buyOrder.lines.0.belowPercent"]);
		expect(limit(-0.01)).toEqual(["buyOrder.lines.0.belowPercent"]);
		expect(limit(0.125)).toEqual(["buyOrder.lines.0.belowPercent"]);
		expect(limit(0.1, 0)).toEqual(["buyOrder.expireBars"]);
		expect(limit(0.1, 101)).toEqual(["buyOrder.expireBars"]);
		// 成行だけなら本数を見ない
		expect(errs({ lines: [{ type: "market" }], expireBars: 0 })).toEqual([]);
	});

	test("買い注文の行: 成行は先頭の1行だけ、指値は下の行ほど大きい %、1〜10 行", () => {
		const errs = (lines: BuyOrderLine[]) =>
			validateConditionSet({
				...strategyTemplate("range").params,
				buyOrder: { lines, expireBars: 3 },
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

	test("最大ポジション数は 1〜10 の整数", () => {
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

	test("行を持つ前の注文方法は1行として読み、最大ポジション数が無ければ 1 で読む", () => {
		const { maxPositions: _, ...old } = strategyTemplate("range").params;
		const limit = parseConditionSet({
			...old,
			buyOrder: { type: "limit", belowPercent: 0.5, expireBars: 7 },
		});
		expect(limit?.buyOrder).toEqual({
			lines: [{ type: "limit", belowPercent: 0.5 }],
			expireBars: 7,
		});
		expect(limit?.maxPositions).toBe(1);
		expect(
			parseConditionSet({
				...old,
				buyOrder: { type: "market", belowPercent: 0.1, expireBars: 3 },
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
		expect(parseConditionSet({ ...params(), timeframe: "2h" })).toBeNull();
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
		expect(
			validateConditionSet(p as ConditionSet).map((e) => e.path),
		).toContain("orderSize");
	});
});

describe("判定に使う足の粒度", () => {
	const withFreq = (
		timeframe: ConditionSet["timeframe"],
		flat: string,
		holding: string,
	): ConditionSet => {
		const f = (v: string) => ({
			value: Number(v.slice(0, -1)),
			unit: v.slice(-1) as "s" | "m" | "h",
		});
		return {
			...strategyTemplate("trend").params,
			timeframe,
			frequency: { flat: f(flat), holding: f(holding) },
		};
	};

	test.each([
		// 戦略の粒度, ポジションなし, あり, 最も細かいデータ, 期待する粒度, 足りないか
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
});

describe("AI 判定の条件", () => {
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
		expect(hit.note).toContain("センチメント判定が0（+1・0のどれか）");
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
			"センチメント判定がデータなし（+1・データなしのどれか）",
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
		lookback: 1,
		direction: "high",
	};
	const loss: Condition = {
		type: "entryChange",
		percent: 1,
		direction: "down",
	};
	const multi = (over: Partial<ConditionSet> = {}) =>
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
			{ kind: "place", side: "buy", type: "market", quantity: 1_000_000 },
			{
				kind: "place",
				side: "buy",
				type: "limit",
				price: 9_950_099,
				quantity: 1_000_000,
				expireAfterBars: 5,
			},
			{
				kind: "place",
				side: "buy",
				type: "limit",
				price: 9_900_099,
				quantity: 1_000_000,
				expireAfterBars: 5,
			},
		]);
		expect(out.state).toEqual({ buyHit: true });
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

	test("最大ポジション数に達していれば買わない", () => {
		const out = evaluateConditionSet(
			input(rising, multi({ maxPositions: 2 }), {
				lots: [lot("b1", 10_000_000), lot("b2", 10_000_000)],
			}),
		);
		expect(out.intents).toEqual([]);
		expect(out.note).toContain("最大ポジション数 2 に達しているため買わない");
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

	test("最大ポジション数が 2 以上なら、前回も条件が成立していたときは買わない（一度外れてから買う）", () => {
		const kept = evaluateConditionSet(
			input(rising, multi(), { state: { buyHit: true } }),
		);
		expect(kept.intents).toEqual([]);
		expect(kept.note).toContain("一度外れてから買う");
		const flat = candles([10_000_000, 10_000_000]);
		expect(
			evaluateConditionSet(input(flat, multi(), { state: { buyHit: true } }))
				.state,
		).toEqual({ buyHit: false });
		expect(
			evaluateConditionSet(input(rising, multi(), { state: { buyHit: false } }))
				.intents,
		).toHaveLength(3);
	});

	test("最大ポジション数が 1 なら前回の成立を見ず、state も変えない（今までどおり）", () => {
		const one = multi({ maxPositions: 1 });
		const out = evaluateConditionSet(
			input(rising, one, { state: { buyHit: true } }),
		);
		expect(out.intents).toHaveLength(1);
		expect(out.state).toEqual({ buyHit: true });
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
		period: 3,
		direction: "above",
	};

	test("終値が EMA より上なら成立し、値を記録に残す", () => {
		// EMA(3) の起点は [1,2,3] の平均 2、次は 10*0.5 + 2*0.5 = 6
		const out = evaluateConditionSet(
			input(candles([1, 2, 3, 10]), buyWith(above)),
		);
		expect(out.intents).toHaveLength(1);
		expect(out.note).toContain("終値 10 が EMA(3) 6 より上");
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
		expect(historyBars(p)).toBe(2001);
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
		expect(historyBars(p)).toBe(506);
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
		expect(out.note).toContain("終値 4 がボリンジャーバンド(3本・1σ)の下限");
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
		expect(historyBars(p)).toBe(20);
		expect(parseConditionSet(JSON.parse(JSON.stringify(p)))?.buy).toEqual(
			p.buy,
		);
	});
});

describe("トレーリングストップ", () => {
	const trail: Condition = { type: "trailingStop", percent: 3 };
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
		expect(out.state).toEqual({ buyHit: false, peaks: { b1: 120 } });
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
			input(candles([100]), sellOn({ type: "holdingBars", bars: 99 }), {
				lots: [lot(0)],
			}),
		);
		expect(out.state).toBeNull();
	});

	test("前回の判定から今回までの足をすべて受け取る", () => {
		const p = params({
			timeframe: "1m",
			frequency: {
				flat: { value: 1, unit: "m" },
				holding: { value: 1, unit: "h" },
			},
			stopLoss: { match: "any", conditions: [trail] },
		});
		expect(historyBars(p)).toBe(61);
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
	const hold: Condition = { type: "holdingBars", bars: 3 };
	const sellOn = params({ takeProfit: { match: "any", conditions: [hold] } });
	const lot = { id: "b1", quantity: 1_000_000, entryPrice: 100, openedAt: 0 };

	test("約定から戦略の粒度の足で N 本経ったら売る", () => {
		const at = (now: number) =>
			evaluateConditionSet(input(candles([100]), sellOn, { lots: [lot], now }));
		expect(at(3 * H - 1).intents).toHaveLength(0);
		const out = at(3 * H);
		expect(out.intents).toHaveLength(1);
		expect(out.note).toContain("買ってから 3 本経過（3 本以上）");
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
