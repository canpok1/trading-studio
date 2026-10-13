import { describe, expect, test } from "bun:test";
import type { BacktestOrder } from "@trading-studio/core";
import { exitBadge } from "./OrderViews";

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

describe("売りのバッジ", () => {
	test("グループ名と、成り立った条件の名前を出す", () => {
		expect(
			exitBadge({
				...sell(
					"短期EMA(12) 12,470,000 が長期EMA(48) 12,480,000 を下抜け。保有中の 0.020 BTC を売却（利確の条件）",
				),
				exitKind: "takeProfit",
			}),
		).toEqual({ kind: "takeProfit", text: "利確: EMA12/48下抜け" });
		expect(
			exitBadge({
				...sell(
					"終値 10,300,000 が直近 24 本の最高値 10,250,000 を上抜け。現在値 10,300,000 は買値 10,000,000 から +3.0%（+2% 以上）。保有中の 0.010 BTC を売却（利確の条件）",
				),
				exitKind: "takeProfit",
			})?.text,
		).toBe("利確: 24本の高値上抜け・+2%");
	});

	test("条件の種類ごとの名前", () => {
		const text = (why: string) =>
			exitBadge({
				...sell(`${why}。保有中の 0.010 BTC を売却（損切りの条件）`),
				exitKind: "stopLoss",
			})?.text;
		expect(text("RSI(14) 72.3 が 70 以上")).toBe("損切り: RSI14 70以上");
		expect(text("RSI(14) が 70 を下抜け（前の足 72.1 → 今 68.0）")).toBe(
			"損切り: RSI14 70下抜け",
		);
		expect(text("RSI(14) が 2 本前に 70 を下抜け（今 65.0）")).toBe(
			"損切り: RSI14 70下抜け",
		);
		expect(text("終値 10,000,000 が EMA(50) 10,100,000 より下")).toBe(
			"損切り: EMA50より下",
		);
		expect(
			text(
				"終値 10,000,000 がボリンジャーバンド(20本・2σ)の下限 10,100,000 以下",
			),
		).toBe("損切り: BB20/2σ下限以下");
		expect(text("トレンド判定が下降（下降・横ばいのどれか）")).toBe(
			"損切り: トレンド下降",
		);
		expect(
			text(
				"現在値 9,700,000 は買ってからの最高値 10,000,000 から −3.0%（−3% 以上）",
			),
		).toBe("損切り: 最高値−3%");
		expect(
			text("現在値 9,800,000 は買値 10,000,000 から −2.0%（−2% 以上）"),
		).toBe("損切り: −2%");
		expect(text("買ってから 48 本経過（48 本以上）")).toBe("損切り: 48本保有");
	});

	test("足を持つ条件は足を付ける", () => {
		const text = (why: string) =>
			exitBadge({
				...sell(`${why}。保有中の 0.010 BTC を売却（損切りの条件）`),
				exitKind: "stopLoss",
			})?.text;
		expect(text("日足のRSI(14) 28.0 が 30 以下")).toBe(
			"損切り: 日足 RSI14 30以下",
		);
		expect(
			text("1時間足の短期EMA(12) 12,470,000 が長期EMA(48) 12,480,000 を下抜け"),
		).toBe("損切り: 1時間足 EMA12/48下抜け");
		expect(
			text("終値 10,000,000 が4時間足の直近 24 本の最安値 10,100,000 を下抜け"),
		).toBe("損切り: 4時間足 24本の安値下抜け");
		expect(text("終値 10,000,000 が日足のEMA(50) 10,100,000 より下")).toBe(
			"損切り: 日足 EMA50より下",
		);
		expect(
			text("4時間足のRSI(14) が 70 を下抜け（前の足 72.1 → 今 68.0）"),
		).toBe("損切り: 4時間足 RSI14 70下抜け");
		expect(text("買ってから日足で 5 本経過（5 本以上）")).toBe(
			"損切り: 日足 5本保有",
		);
	});

	test("複数のロットを売った判断では、自分のロットの条件だけを出す", () => {
		const reason =
			"現在値 10,300,000 は買値 10,000,000 から +3.0%（+2% 以上）。買値 10,000,000 のロット 0.010 BTC を売却（利確の条件）。現在値 10,300,000 は買値 10,600,000 から −2.8%（−2% 以上）。買値 10,600,000 のロット 0.010 BTC を売却（損切りの条件）";
		expect(
			exitBadge({ ...sell(reason), lotPrice: 10_600_000, exitKind: "stopLoss" })
				?.text,
		).toBe("損切り: −2%");
	});

	test("グループが分からない過去の売りは条件名だけ出す", () => {
		expect(
			exitBadge(
				sell(
					"短期EMA(12) 12,470,000 が長期EMA(48) 12,480,000 を下抜け。保有中の 0.020 BTC を売却（利確の条件）",
				),
			),
		).toEqual({ kind: null, text: "EMA12/48下抜け" });
	});

	test("一部利確と、発動の条件つきのトレーリングストップ", () => {
		expect(
			exitBadge({
				...sell(
					"現在値 10,800,000 は買値 10,000,000 から +8.0%（+8% 以上）。買値 10,000,000 のロット 0.010 BTC のうち 0.005 BTC を売却（一部利確の条件）",
				),
				lotPrice: 10_000_000,
				exitKind: "partialTakeProfit",
			}),
		).toEqual({ kind: "partialTakeProfit", text: "一部利確: +8%" });
		expect(
			exitBadge({
				...sell(
					"現在値 10,300,000 は買ってからの最高値 10,700,000 から −3.7%（−3% 以上）。最高値が買値から +5% 以上になってから発動。保有中の 0.005 BTC を売却（利確の条件）",
				),
				exitKind: "takeProfit",
			})?.text,
		).toBe("利確: 最高値−3%");
	});

	test("買いには付けない", () => {
		expect(exitBadge({ ...sell("買い"), side: "buy" })).toBeNull();
	});
});
