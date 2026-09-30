import { describe, expect, test } from "bun:test";
import type { TradeOrder } from "@trading-studio/core";
import { EMPTY_POSITION } from "@trading-studio/core";
import { tradingPerformance } from "./performance";

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
			position: EMPTY_POSITION,
			price: 1.1 * P,
			fills,
			// 1本目の保有中に 20% 下がった
			prices: [{ time: 2 * H, price: 0.8 * P }],
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
	});

	test("保有があって価格が分からなければ資産と損益は null", () => {
		const r = tradingPerformance({
			initialCash: 1_000_000,
			resetAt: 0,
			now: H,
			cash: 900_000,
			position: { quantity: 1_000_000, entryPrice: P, openedAt: 0 },
			price: null,
			fills: [order({})],
			prices: [],
		});
		expect(r).toMatchObject({ equity: null, pnl: null, pnlPercent: null });
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
			position: EMPTY_POSITION,
			price: P,
			fills,
			prices: [],
		});
		expect(r).toMatchObject({
			realizedPnl: 2_500,
			trades: 1,
			wins: 1,
			losses: 0,
			averageHoldingMs: 3 * H,
		});
	});
});
