import { describe, expect, test } from "bun:test";
import type { BacktestOrder } from "@trading-studio/core";
import { orderKind } from "./OrderViews";

const sell = (reason: string): BacktestOrder => ({
	id: "o2",
	side: "sell",
	type: "market",
	price: null,
	quantity: 2_000_000,
	placedAt: 0,
	status: "filled",
	filledAt: 0,
	fillPrice: 1,
	fee: 0,
	canceledAt: null,
	cancelReason: null,
	reason,
	pairId: "o1",
	pnl: -2184,
});

describe("売りのきっかけ", () => {
	test("グループ名ではなく、成り立った条件の名前で出す", () => {
		expect(
			orderKind(
				sell(
					"短期EMA(12) 12,470,000 が長期EMA(48) 12,480,000 を下抜け。保有中の 0.020 BTC を売却（利確の条件）",
				),
			),
		).toBe("EMA12/48下抜け");
		expect(
			orderKind(
				sell(
					"現在値 9,800,000 は買値 10,000,000 から −2.0%（−2% 以上）。保有中の 0.020 BTC を売却（損切りの条件）",
				),
			),
		).toBe("−2%");
		expect(
			orderKind(
				sell(
					"終値 10,300,000 が直近 24 本の最高値 10,250,000 を上抜け。現在値 10,300,000 は買値 10,000,000 から +3.0%（+2% 以上）。保有中の 0.010 BTC を売却（利確の条件）",
				),
			),
		).toBe("24本の高値上抜け・+2%");
	});

	test("買いには付けない", () => {
		expect(orderKind({ ...sell("買い"), side: "buy" })).toBeNull();
	});
});
