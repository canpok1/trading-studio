import { describe, expect, test } from "bun:test";
import type { BacktestConfig } from "./backtest";
import { BacktestAborted, BacktestError, runBacktest } from "./backtest";
import type { ConditionSet } from "./condition-strategy";
import { conditionStrategy } from "./condition-strategy";
import type { Strategy } from "./strategy";
import { strategyTemplate } from "./templates";
import { TIMEFRAME_MS } from "./timeframe";
import type { Candle } from "./types";

const H = TIMEFRAME_MS["1h"];
const Q = 1_000_000; // 0.01 BTC

type Bar = [open: number, high: number, low: number, close: number];
const bars = (list: Bar[], start = 0): Candle[] =>
	list.map(([open, high, low, close], i) => ({
		time: start + i * H,
		open,
		high,
		low,
		close,
		volume: 0,
	}));

// 1回だけ指値で買い、買えたら次の判定で成行で売る戦略
type Script = { buyPrice: number; expire?: number; sell?: boolean };
const scripted: Strategy<Script> = {
	id: "scripted",
	requiredJudges: () => [],
	minResolution: () => "1h",
	historyBars: () => 1,
	validate: () => [],
	evaluate: ({ now, position, openOrders, params, state }) => {
		const next = { intents: [], nextEvalAt: now + H, state };
		if (position.quantity > 0) {
			return params.sell === false
				? next
				: {
						...next,
						intents: [
							{
								kind: "place",
								side: "sell",
								type: "market",
								quantity: position.quantity,
							},
						],
						note: "売り",
					};
		}
		if (state !== null || openOrders.length > 0) return next;
		return {
			intents: [
				{
					kind: "place",
					side: "buy",
					type: "limit",
					price: params.buyPrice,
					quantity: Q,
					expireAfterBars: params.expire ?? 3,
				},
			],
			nextEvalAt: now + H,
			state: "bought",
			note: "買い",
		};
	},
};

function config(
	candles: Candle[],
	params: Script,
	over: Partial<BacktestConfig<Script>> = {},
): BacktestConfig<Script> {
	return {
		strategy: scripted,
		params,
		candles,
		dataTimeframe: "1h",
		from: 0,
		to: candles.length * H,
		initialCash: 1_000_000,
		fees: { limitPpm: 1000, marketPpm: 2000 },
		...over,
	};
}

describe("約定", () => {
	const candles = bars([
		[10_000_000, 10_000_000, 10_000_000, 10_000_000], // 終わりに指値 9,900,000 で買い注文
		[10_000_000, 10_000_000, 9_950_000, 9_950_000], // 届かない
		[9_950_000, 9_950_000, 9_800_000, 9_900_000], // 届く → 約定。終わりに成行の売り
		[10_500_000, 10_600_000, 10_400_000, 10_500_000], // 始値で約定
	]);

	test("指値は値幅が届いた足で指値の価格、成行は次の足の始値で約定する", () => {
		const r = runBacktest(config(candles, { buyPrice: 9_900_000 }));
		const [buy, sell] = r.orders;
		expect(buy).toMatchObject({
			status: "filled",
			filledAt: 2 * H,
			fillPrice: 9_900_000,
			fee: 99, // 99,000 × 0.1%
			pairId: "o2",
		});
		expect(sell).toMatchObject({
			type: "market",
			status: "filled",
			placedAt: 3 * H,
			filledAt: 3 * H,
			fillPrice: 10_500_000,
			fee: 210, // 105,000 × 0.2%
			pairId: "o1",
			pnl: 105_000 - 210 - 99_000 - 99,
		});
		expect(r.summary.finalEquity).toBe(1_000_000 + 105_000 - 210 - 99_000 - 99);
		expect(r.summary.trades).toBe(1);
		expect(r.summary.wins).toBe(1);
		expect(r.summary.winRate).toBe(100);
		expect(r.summary.profitFactor).toBeNull();
	});

	test("約定があれば次回時刻を待たずに、その足の終わりで判定する", () => {
		const r = runBacktest(config(candles, { buyPrice: 9_900_000 }));
		expect(r.decisions.map((d) => d.time)).toEqual([H, 2 * H, 3 * H, 4 * H]);
	});
});

describe("指値の取消", () => {
	test("指定の本数のあいだ約定しなければ、その本数目の足の終わりで取り消す", () => {
		const flat: Bar = [10_000_000, 10_000_000, 10_000_000, 10_000_000];
		const r = runBacktest(
			config(bars([flat, flat, flat, flat, flat]), { buyPrice: 9_000_000 }),
		);
		expect(r.orders[0]).toMatchObject({
			status: "canceled",
			canceledAt: 4 * H,
			cancelReason: "指値 9,000,000 が 3 本のあいだ約定しなかったため取消",
		});
	});

	test("期間の終わりで未約定の注文は取り消して残す", () => {
		const flat: Bar = [10_000_000, 10_000_000, 10_000_000, 10_000_000];
		const r = runBacktest(config(bars([flat, flat]), { buyPrice: 9_000_000 }));
		expect(r.orders[0]?.status).toBe("canceled");
		expect(r.orders[0]?.cancelReason).toBe("期間の終わりまで約定しなかった");
	});
});

describe("未決済のポジション", () => {
	test("最後の足の終値で評価して最終資金に含め、取引回数には含めない", () => {
		const r = runBacktest(
			config(
				bars([
					[10_000_000, 10_000_000, 10_000_000, 10_000_000],
					[10_000_000, 10_000_000, 9_900_000, 11_000_000],
				]),
				{ buyPrice: 10_000_000, sell: false },
			),
		);
		// 買い 100,000 + 手数料 100、評価 110,000
		expect(r.summary.finalEquity).toBe(1_000_000 - 100_100 + 110_000);
		expect(r.summary.pnl).toBe(9_900);
		expect(r.summary.trades).toBe(0);
		expect(r.summary.winRate).toBeNull();
		expect(r.summary.averageHoldingMs).toBeNull();
		expect(r.summary.openPositionQuantity).toBe(Q);
	});
});

describe("成績", () => {
	test("最大ドローダウンは足ごとの時価評価の高値からの下落率", () => {
		const r = runBacktest(
			config(
				bars([
					[10_000_000, 10_000_000, 10_000_000, 10_000_000],
					[10_000_000, 10_000_000, 10_000_000, 10_000_000], // 買い（10,000,000）
					[10_000_000, 10_000_000, 10_000_000, 60_000_000], // 評価 +500,000
					[60_000_000, 60_000_000, 60_000_000, 10_000_000], // 評価が戻る
				]),
				{ buyPrice: 10_000_000, sell: false },
			),
		);
		// 高値: 1,000,000 − 100 + 500,000 = 1,499,900 → 999,900
		expect(r.summary.maxDrawdownPercent).toBeCloseTo(
			(500_000 / 1_499_900) * 100,
			10,
		);
		expect(r.summary.maxDrawdownFrom).toBe(3 * H);
		expect(r.summary.maxDrawdownTo).toBe(4 * H);
	});

	test("ガチホ比は最初の足の始値で全額買い（手数料込み）、最後の足の終値で評価する", () => {
		const r = runBacktest(
			config(
				bars([
					[10_000_000, 10_000_000, 10_000_000, 10_000_000],
					[10_000_000, 12_000_000, 10_000_000, 12_000_000],
				]),
				{ buyPrice: 1 },
				{ fees: { limitPpm: 0, marketPpm: 0 } },
			),
		);
		expect(r.summary.buyAndHoldPercent).toBeCloseTo(20, 10);
	});

	test("負けがあれば PF は総利益 ÷ 総損失、勝ちが無ければ 0", () => {
		const r = runBacktest(
			config(
				bars([
					[10_000_000, 10_000_000, 10_000_000, 10_000_000],
					[10_000_000, 10_000_000, 10_000_000, 10_000_000],
					[9_000_000, 9_000_000, 9_000_000, 9_000_000],
				]),
				{ buyPrice: 10_000_000 },
			),
		);
		expect(r.summary.losses).toBe(1);
		expect(r.summary.profitFactor).toBe(0);
		expect(r.summary.averageHoldingMs).toBe(H);
	});
});

describe("実行前の検証", () => {
	const candles = bars([[1, 1, 1, 1]]);
	test("データが戦略の粒度より粗ければエラー", () => {
		expect(() =>
			runBacktest(config(candles, { buyPrice: 1 }, { dataTimeframe: "1d" })),
		).toThrow(BacktestError);
	});
	test("期間に足が無ければエラー", () => {
		expect(() =>
			runBacktest(
				config(candles, { buyPrice: 1 }, { from: 10 * H, to: 20 * H }),
			),
		).toThrow("期間に足が無い");
	});
});

describe("期間と指標", () => {
	test("期間より前の足は指標の計算に使い、売買はしない", () => {
		const seen: number[] = [];
		const spy: Strategy<Script> = {
			...scripted,
			historyBars: () => 3,
			evaluate: (input) => {
				seen.push(input.candles.length);
				return { intents: [], nextEvalAt: input.now + H, state: null };
			},
		};
		const flat: Bar = [1, 1, 1, 1];
		const r = runBacktest({
			...config(bars([flat, flat, flat, flat]), { buyPrice: 1 }),
			strategy: spy,
			from: 2 * H,
		});
		expect(seen).toEqual([3, 3]);
		expect(r.candles).toHaveLength(2);
	});
});

describe("判定頻度が戦略の粒度より短い", () => {
	const M15 = TIMEFRAME_MS["15m"];
	const P = 10_000_000;
	// 1時間足の戦略。ポジションありは15分ごとに判定し、買値から1%下がったら損切り
	const params: ConditionSet = {
		timeframe: "1h",
		frequency: {
			flat: { value: 15, unit: "m" },
			holding: { value: 15, unit: "m" },
		},
		orderSize: Q,
		buy: {
			match: "all",
			conditions: [{ type: "breakout", lookback: 2, direction: "high" }],
		},
		takeProfit: { match: "any", conditions: [] },
		stopLoss: {
			match: "any",
			conditions: [{ type: "entryChange", percent: 1, direction: "down" }],
		},
	};
	const flat: Bar = [P, P, P, P];
	const quarters: Bar[] = [
		...Array<Bar>(8).fill(flat),
		[P, P + 200_000, P, P + 200_000], // 直近2本の高値を上抜け → 10,189,800 に指値
		[P + 200_000, P + 200_000, 10_180_000, P + 200_000], // 指値が約定
		[P + 200_000, P + 200_000, P, P], // 買値から −1.9% → 成行で売り
		flat, // 始値で約定
		...Array<Bar>(4).fill(flat),
	];
	const q = quarters.map(([open, high, low, close], i) => ({
		time: i * M15,
		open,
		high,
		low,
		close,
		volume: 0,
	}));
	// 15分足から作った1時間足
	const hours: Candle[] = [];
	for (let i = 0; i < q.length; i += 4) {
		const g = q.slice(i, i + 4);
		hours.push({
			time: (g[0] as Candle).time,
			open: (g[0] as Candle).open,
			high: Math.max(...g.map((c) => c.high)),
			low: Math.min(...g.map((c) => c.low)),
			close: (g.at(-1) as Candle).close,
			volume: 0,
		});
	}
	const base = {
		strategy: conditionStrategy,
		params,
		candles: hours,
		dataTimeframe: "15m" as const,
		from: 0,
		to: hours.length * H,
		initialCash: 20_000_000,
		fees: { limitPpm: 0, marketPpm: 0 },
	};

	test("細かい足を渡すと、足の途中でも判定頻度どおりに判定して売る", () => {
		const r = runBacktest({ ...base, stepCandles: q, stepTimeframe: "15m" });
		const [buy, sell] = r.orders;
		expect(buy).toMatchObject({ price: 10_189_800, placedAt: 2 * H + M15 });
		expect(buy?.filledAt).toBe(2 * H + M15);
		expect(sell).toMatchObject({
			side: "sell",
			placedAt: 2 * H + 3 * M15,
			filledAt: 2 * H + 3 * M15,
			fillPrice: P,
		});
		expect(r.decisions).toHaveLength(q.length);
		// チャートの足は戦略の粒度のまま
		expect(r.candles).toHaveLength(hours.length);
	});

	test("細かい足を渡さなければ、戦略の粒度の足の終わりにだけ判定する", () => {
		const r = runBacktest(base);
		expect(r.decisions.map((d) => d.time)).toEqual(
			hours.map((h) => h.time + H),
		);
	});

	test("判定に使う足が戦略の粒度より粗ければ実行しない", () => {
		expect(() =>
			runBacktest({ ...base, stepCandles: hours, stepTimeframe: "4h" }),
		).toThrow(BacktestError);
	});
});

describe("進捗と中止", () => {
	const flat: Bar = [1, 1, 1, 1];
	test("最後に処理本数を通知する", () => {
		const calls: [number, number][] = [];
		runBacktest(
			config(
				bars([flat, flat]),
				{ buyPrice: 1 },
				{
					onProgress: (d, t) => calls.push([d, t]),
				},
			),
		);
		expect(calls.at(-1)).toEqual([2, 2]);
	});
	test("shouldAbort が true なら中止する", () => {
		expect(() =>
			runBacktest(
				config(bars([flat]), { buyPrice: 1 }, { shouldAbort: () => true }),
			),
		).toThrow(BacktestAborted);
	});
});

describe("決定論", () => {
	test("条件戦略で同じ入力なら同じ結果になる", () => {
		const params = strategyTemplate("trend").params;
		const candles: Candle[] = Array.from({ length: 2000 }, (_, i) => {
			const p = 10_000_000 + Math.round(Math.sin(i / 30) * 800_000 + i * 500);
			return {
				time: i * H,
				open: p,
				high: p + 100_000,
				low: p - 100_000,
				close: p,
				volume: 0,
			};
		});
		const run = () =>
			runBacktest({
				strategy: conditionStrategy,
				params,
				candles,
				dataTimeframe: "1m",
				from: 500 * H,
				to: 2000 * H,
				initialCash: 2_000_000,
				fees: { limitPpm: 1000, marketPpm: 1000 },
			});
		const a = run();
		expect(a.summary.trades).toBeGreaterThan(0);
		expect(run()).toEqual(a);
	});
});
