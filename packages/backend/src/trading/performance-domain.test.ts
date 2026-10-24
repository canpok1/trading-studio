import { describe, expect, test } from "bun:test";
import type { TradeOrder } from "@trading-studio/core";
import { BTC_JPY, EMPTY_POSITION, ETH_JPY } from "@trading-studio/core";
import { tradingPerformance } from "./performance-domain";

const H = 3_600_000;
const P = 10_000_000;

const order = (over: Partial<TradeOrder>): TradeOrder => ({
	id: "p1",
	side: "buy",
	type: "market",
	price: null,
	quantity: 1_000_000,
	placedAt: 0,
	status: "filled",
	filledAt: 0,
	fillPrice: P,
	fee: 0,
	canceledAt: null,
	cancelReason: null,
	reason: "",
	pairId: null,
	pnl: null,
	...over,
});

describe("tradingPerformance", () => {
	test("保有中の値下がりを足の終値で最大DDに数え、往復の損益から勝率・PF・平均保有を出す", () => {
		const fills = [
			order({ id: "p1", filledAt: H, pairId: "p2" }),
			order({
				id: "p2",
				side: "sell",
				filledAt: 3 * H,
				fillPrice: P,
				pairId: "p1",
				pnl: 0,
			}),
			order({ id: "p3", filledAt: 4 * H, pairId: "p4" }),
			order({
				id: "p4",
				side: "sell",
				filledAt: 5 * H,
				fillPrice: 1.1 * P,
				pairId: "p3",
				pnl: 10_000,
			}),
		];
		const r = tradingPerformance({
			initialCash: 1_000_000,
			resetAt: 0,
			now: 6 * H,
			cash: 1_010_000,
			fills,
			markets: [
				{
					instrument: BTC_JPY,
					position: EMPTY_POSITION,
					price: 1.1 * P,
					// 1本目の保有中に 20% 下がった
					prices: [{ time: 2 * H, price: 0.8 * P }],
					basePrice: P,
				},
			],
		});
		expect(r).toMatchObject({
			equity: 1_010_000,
			pnl: 10_000,
			realizedPnl: 10_000,
			trades: 2,
			wins: 1,
			losses: 1,
			winRate: 50,
			profitFactor: null,
			maxDrawdownPercent: 2,
			maxDrawdownFrom: 0,
			maxDrawdownTo: 2 * H,
			averageHoldingMs: 1.5 * H,
		});
		// ガチホはリセット時の価格から今の価格まで
		expect(r.buyHoldPercent).toBeCloseTo(10);
	});

	test("保有があって価格が分からなければ資産と損益は null", () => {
		const r = tradingPerformance({
			initialCash: 1_000_000,
			resetAt: 0,
			now: H,
			cash: 900_000,
			fills: [order({})],
			markets: [
				{
					instrument: BTC_JPY,
					position: { quantity: 1_000_000, entryPrice: P, openedAt: 0 },
					price: null,
					prices: [],
					basePrice: P,
				},
			],
		});
		expect(r).toMatchObject({
			equity: null,
			pnl: null,
			pnlPercent: null,
			buyHoldPercent: null,
		});
	});

	test("一部利確の売りは、ロットを閉じた売りと1往復にまとめる。残っている間は確定損益にだけ数える", () => {
		const fills = [
			order({ id: "p1", filledAt: H, pairId: "p3" }),
			order({
				id: "p2",
				side: "sell",
				quantity: 500_000,
				filledAt: 2 * H,
				pairId: "p1",
				pnl: 3_000,
				exitKind: "partialTakeProfit",
			}),
			order({
				id: "p3",
				side: "sell",
				quantity: 500_000,
				filledAt: 4 * H,
				pairId: "p1",
				pnl: -1_000,
				exitKind: "stopLoss",
			}),
			order({ id: "p4", filledAt: 5 * H }),
			order({
				id: "p5",
				side: "sell",
				quantity: 500_000,
				filledAt: 6 * H,
				pairId: "p4",
				pnl: 500,
				exitKind: "partialTakeProfit",
			}),
		];
		const r = tradingPerformance({
			initialCash: 1_000_000,
			resetAt: 0,
			now: 7 * H,
			cash: 1_000_000,
			fills,
			markets: [
				{
					instrument: BTC_JPY,
					position: EMPTY_POSITION,
					price: P,
					prices: [],
					basePrice: null,
				},
			],
		});
		expect(r).toMatchObject({
			realizedPnl: 2_500,
			trades: 1,
			wins: 1,
			losses: 0,
			averageHoldingMs: 3 * H,
		});
	});

	test("銘柄が2つ以上なら、資産と最大DDは全銘柄の合計で測り、往復の成績を銘柄ごとにも出す", () => {
		const E = 500_000; // ETH の価格（円）
		const fills = [
			// 銘柄を持たない約定は先頭の銘柄（BTC）
			order({ id: "p1", filledAt: H, pairId: "p3" }),
			order({
				id: "p2",
				instrument: ETH_JPY.id,
				quantity: 20_000, // 0.2 ETH = 100,000円
				fillPrice: E,
				filledAt: H,
			}),
			order({
				id: "p3",
				side: "sell",
				filledAt: 3 * H,
				fillPrice: 1.1 * P,
				pairId: "p1",
				pnl: 10_000,
			}),
		];
		const r = tradingPerformance({
			initialCash: 1_000_000,
			resetAt: 0,
			now: 4 * H,
			cash: 910_000,
			fills,
			markets: [
				{
					instrument: BTC_JPY,
					position: EMPTY_POSITION,
					price: 1.1 * P,
					prices: [],
					basePrice: P,
				},
				{
					instrument: ETH_JPY,
					position: { quantity: 20_000, entryPrice: E, openedAt: H },
					price: E,
					// BTC の保有中に ETH が半値になった（100,000円 → 50,000円）
					prices: [{ time: 2 * H, price: 0.5 * E }],
					basePrice: 0.8 * E,
				},
			],
		});
		expect(r).toMatchObject({
			equity: 1_010_000,
			pnl: 10_000,
			trades: 1,
			// 2時間後の資産は 現金 800,000 + BTC 100,000 + ETH 50,000
			maxDrawdownPercent: 5,
			maxDrawdownTo: 2 * H,
			byInstrument: {
				[BTC_JPY.id]: { realizedPnl: 10_000, trades: 1, wins: 1 },
				[ETH_JPY.id]: { realizedPnl: 0, trades: 0, winRate: null },
			},
		});
		// ガチホは銘柄ごとの率（BTC +10%・ETH +25%）を等分する
		expect(r.buyHoldPercent).toBeCloseTo(17.5);
	});

	test("同じ時刻の価格は全銘柄に当ててから測り、新旧の価格が混ざった資産を最大DDに数えない", () => {
		const E = 500_000;
		const r = tradingPerformance({
			initialCash: 1_000_000,
			resetAt: 0,
			now: 3 * H,
			cash: 800_000,
			fills: [
				order({ id: "p1", filledAt: H }),
				order({
					id: "p2",
					instrument: ETH_JPY.id,
					quantity: 20_000,
					fillPrice: E,
					filledAt: H,
				}),
			],
			markets: [
				{
					instrument: BTC_JPY,
					position: { quantity: 1_000_000, entryPrice: P, openedAt: H },
					price: P,
					// 同じ1時間で BTC が倍・ETH が半値（合計は変わらない）
					prices: [{ time: 2 * H, price: 2 * P }],
					basePrice: P,
				},
				{
					instrument: ETH_JPY,
					position: { quantity: 20_000, entryPrice: E, openedAt: H },
					price: E,
					prices: [{ time: 2 * H, price: 0.5 * E }],
					basePrice: E,
				},
			],
		});
		// 2時間後は 800,000 + 200,000 + 50,000 = 1,050,000。BTC だけ先に当てた 1,100,000 を山にしない
		expect(r.maxDrawdownFrom).toBe(2 * H);
		expect(r.maxDrawdownPercent).toBeCloseTo((1 - 1_000_000 / 1_050_000) * 100);
	});
});
