import { describe, expect, test } from "bun:test";
import type {
	BacktestOrder,
	ConditionSet,
	SingleBuyConditionSet,
} from "@trading-studio/core";
import {
	BTC_JPY,
	COINCHECK,
	conditionScreenText,
	DEFAULT_BUY_ORDER,
	DEFAULT_PARTIAL_SELL,
	singleBuy,
	TIMEFRAME_MS,
} from "@trading-studio/core";
import type { BacktestRun } from "../backtests/types-domain";
import { aggregateBars, buildAdviceSource, selectBars } from "./input-domain";

const M = TIMEFRAME_MS["1m"];
const CAL = COINCHECK.calendar;
// JST 2026-08-01 00:00
const START = Date.UTC(2026, 6, 31, 15);

const bar = (time: number, close: number) => ({
	time,
	open: close,
	high: close + 10,
	low: close - 10,
	close,
});

const order = (placedAt: number): BacktestOrder => ({
	id: `o${placedAt}`,
	side: "buy",
	type: "market",
	price: null,
	quantity: 1_000_000,
	placedAt,
	status: "filled",
	filledAt: placedAt,
	fillPrice: 100,
	fee: 0,
	canceledAt: null,
	cancelReason: null,
	reason: "テスト",
	pairId: null,
	pnl: null,
});

const FLAT: SingleBuyConditionSet = {
	frequency: {
		flat: { value: 1, unit: "h" },
		holding: { value: 1, unit: "h" },
	},
	orderSize: 1_000_000,
	maxPositions: 1,
	dailyLossLimit: 30_000,
	stopLossCooldownBars: 0,
	stopLossCooldownTimeframe: "1h",
	buy: {
		match: "all",
		conditions: [
			{ type: "breakout", timeframe: "1h", lookback: 5, direction: "high" },
		],
	},
	buyOrder: DEFAULT_BUY_ORDER,
	partialTakeProfit: { match: "all", conditions: [] },
	partialSell: DEFAULT_PARTIAL_SELL,
	takeProfit: {
		match: "any",
		conditions: [{ type: "entryChange", percent: 1, direction: "up" }],
	},
	stopLoss: {
		match: "any",
		conditions: [{ type: "entryChange", percent: 1, direction: "down" }],
	},
};
const PARAMS: ConditionSet = singleBuy(FLAT);

describe("AI に渡す足", () => {
	const bars = Array.from({ length: 6_000 }, (_, i) =>
		bar(START + i * M, 1_000 + i),
	);

	test("上限以下なら戦略の足をすべて渡す", () => {
		const sel = selectBars(bars.slice(0, 100), "1m", CAL, [], 100);
		expect(sel).toEqual({ kind: "all", bars: bars.slice(0, 100) });
	});

	test("上限を超えたら、全体は上限の半分に収まる粗さにまとめ、注文の前後だけ戦略の足で渡す", () => {
		const sel = selectBars(
			bars,
			"1m",
			CAL,
			[order(START + 3_000 * M)],
			3_000,
			10,
		);
		if (sel.kind !== "reduced") throw new Error("絞られていない");
		// 1分足6000本 → 5分足1200本（15分足より細かく、1500本以下）
		expect(sel.overviewTimeframe).toBe("5m");
		expect(sel.overview).toHaveLength(1_200);
		expect(sel.windows).toHaveLength(1);
		expect(sel.windows[0]?.map((b) => b.time)).toEqual(
			Array.from({ length: 21 }, (_, i) => START + (2_990 + i) * M),
		);
		expect(sel.truncated).toBe(false);
	});

	test("注文の前後が重なれば1つの区間にし、枠に収まらなければ前後の本数を減らす", () => {
		const orders = [order(START + 100 * M), order(START + 105 * M)];
		const wide = selectBars(bars, "1m", CAL, orders, 3_000, 10);
		if (wide.kind !== "reduced") throw new Error("絞られていない");
		expect(wide.windows).toHaveLength(1);
		expect(wide.windows[0]).toHaveLength(26);

		// 全体 1200 本、残りの枠 1800 本。100 件の注文の前後 10 本ずつ（2100 本）は収まらず、5 本ずつに減らす
		const many = Array.from({ length: 100 }, (_, i) =>
			order(START + (30 + i * 50) * M),
		);
		const narrow = selectBars(bars, "1m", CAL, many, 3_000, 10);
		if (narrow.kind !== "reduced") throw new Error("絞られていない");
		expect(narrow.windowBars).toBe(5);
		expect(narrow.windows.flat()).toHaveLength(1_100);
		expect(narrow.truncated).toBe(false);
	});

	test("まとめた足は始値・高値・安値・終値を引き継ぐ", () => {
		expect(aggregateBars(bars.slice(0, 5), "5m", CAL)).toEqual([
			{ time: START, open: 1_000, high: 1_014, low: 990, close: 1_004 },
		]);
	});
});

describe("AI に渡す資料", () => {
	test("取消の理由のカンマで注文の表の列がずれない", () => {
		const o = {
			...order(START),
			status: "canceled" as const,
			filledAt: null,
			canceledAt: START + M,
			cancelReason: "指値 15,000,000 が約定しなかった",
		};
		const text = buildAdviceSource({
			run: {
				instrument: BTC_JPY,
				params: PARAMS,
				timeframe: "1m",
				stepTimeframe: "1m",
				stepLimited: false,
				from: START,
				to: START + 2 * M,
				initialCash: 1,
				fees: { limitPpm: 0, marketPpm: 0 },
				summary: null,
				aggregationRule: null,
			} as unknown as BacktestRun,
			bars: [bar(START, 1), bar(START + M, 2)],
			orders: [o],
			judgments: null,
		});
		const table = text.split("\n## 注文")[1]?.split("\n") ?? [];
		const cols = (line = "") => line.split(",").length;
		expect(cols(table[2])).toBe(cols(table[1]));
		expect(table[2]).toContain("指値 15 000 000 が約定しなかった");
	});

	test("粗い足にまとめたとき、期間の終わりが足の途中なら期間の最後の判定を使う", () => {
		// 1分足88本を5分足18本にまとめる。最後の5分足は3本しか無い
		const bars = Array.from({ length: 88 }, (_, i) => bar(START + i * M, i));
		const sentiment = bars.map((_, i) => (i === 87 ? "+2" : "-1") as "+2");
		const text = buildAdviceSource(
			{
				run: {
					instrument: BTC_JPY,
					params: PARAMS,
					timeframe: "1m",
					stepTimeframe: "1m",
					stepLimited: false,
					from: START,
					to: START + 88 * M,
					initialCash: 1,
					fees: { limitPpm: 0, marketPpm: 0 },
					summary: null,
					aggregationRule: null,
				} as unknown as BacktestRun,
				bars,
				orders: [],
				judgments: {
					from: START,
					step: M,
					firstScoredAt: 0,
					values: {
						sentiment,
						risk: bars.map(() => "calm" as const),
					},
				},
			},
			60,
		);
		const overview = text.split("## 値動きの全体")[1]?.split("\n\n")[0] ?? "";
		expect(overview).toContain("5分足、18 本");
		expect(overview.trim().split("\n").at(-1)).toMatch(/,かなり強気,平常$/);
	});
});

describe("画面の表記", () => {
	test("条件は戦略画面の文言で書く", () => {
		expect(
			conditionScreenText({
				type: "emaCross",
				timeframe: "1h",
				fast: 12,
				slow: 48,
				direction: "up",
			}),
		).toBe("1時間足で 短期EMA 12 本が 長期EMA 48 本を上抜けた");
		expect(
			conditionScreenText({
				type: "judgment",
				judge: "sentiment",
				values: ["+2", "+1"],
			}),
		).toBe("センチメントが かなり強気・やや強気 のどれか");
		expect(
			conditionScreenText({
				type: "rsi",
				timeframe: "1h",
				period: 14,
				threshold: 30,
				direction: "below",
			}),
		).toBe("1時間足で RSI 14 本が 30 以下");
	});
});
