import { describe, expect, test } from "bun:test";
import type { StrategySummary } from "@trading-studio/backend";
import { BTC_JPY } from "@trading-studio/core";
import { compared } from "./compare";

const summary = (
	performance: Partial<NonNullable<StrategySummary["performance"]>> | null,
): StrategySummary =>
	({
		status: { instrument: BTC_JPY, account: { lots: [{}, {}] } },
		performance: performance && {
			pnl: 18_420,
			pnlPercent: 1.842,
			realizedPnl: -500,
			trades: 13,
			wins: 8,
			losses: 5,
			winRate: 61.54,
			profitFactor: null,
			maxDrawdownPercent: 2.34,
			averageHoldingMs: 3 * 3_600_000,
			price: 10_100_000,
			position: { quantity: 2_000_000, entryPrice: 10_000_000, openedAt: 0 },
			...performance,
		},
		nextMoves: null,
	}) as unknown as StrategySummary;

describe("ホームのカードで比べる値", () => {
	test("値と補足を単位付きで出す", () => {
		const s = summary({});
		expect(compared(s, "pnl")).toMatchObject({
			text: "+18,420円",
			sub: "+1.8%",
			tone: "profit",
		});
		// 0.02 BTC が 100,000 円上がった
		expect(compared(s, "unrealized")).toMatchObject({
			text: "+2,000円",
			sub: "保有 2 ロット",
		});
		expect(compared(s, "realized")).toMatchObject({
			text: "−500円",
			tone: "loss",
		});
		expect(compared(s, "winRate")).toMatchObject({
			text: "61.5%",
			sub: "8勝 5敗",
		});
		expect(compared(s, "profitFactor")).toMatchObject({
			text: "∞",
		});
		expect(compared(s, "maxDrawdown")).toMatchObject({
			text: "−2.3%",
			tone: "loss",
		});
		expect(compared(s, "trades")).toMatchObject({
			text: "13回",
			sub: "平均保有 3.0時間",
		});
	});

	test("取引が無ければ PF は出さない。成績が読めなければ —", () => {
		expect(compared(summary({ trades: 0 }), "profitFactor")).toMatchObject({
			text: "—",
		});
		expect(compared(summary(null), "pnl")).toMatchObject({
			text: "—",
		});
	});
});
