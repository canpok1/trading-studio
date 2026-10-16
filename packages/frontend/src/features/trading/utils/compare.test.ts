import { describe, expect, test } from "bun:test";
import type { StrategySummary } from "@trading-studio/backend";
import { barOf, compared } from "./compare";

const summary = (
	performance: Partial<NonNullable<StrategySummary["performance"]>> | null,
): StrategySummary =>
	({
		status: { account: { lots: [{}, {}] } },
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
			amount: Number.POSITIVE_INFINITY,
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
			amount: null,
		});
		expect(compared(summary(null), "pnl")).toMatchObject({
			text: "—",
			amount: null,
		});
	});

	test("棒は並べた中で一番大きい値を目いっぱいにする。損益は中央から左右へ", () => {
		expect(barOf(50, [50, 25], false)).toEqual({ left: 0, width: 100 });
		expect(barOf(25, [50, 25], false)).toEqual({ left: 0, width: 50 });
		expect(barOf(100, [-200, 100], true)).toEqual({ left: 50, width: 25 });
		expect(barOf(-200, [-200, 100], true)).toEqual({ left: 0, width: 50 });
		// 全部 0 なら棒は出さない長さ
		expect(barOf(0, [0, 0], true)).toEqual({ left: 50, width: 0 });
		// PF の ∞ は目いっぱい
		expect(
			barOf(Number.POSITIVE_INFINITY, [Number.POSITIVE_INFINITY, 1.5], false),
		).toEqual({
			left: 0,
			width: 100,
		});
		expect(barOf(null, [1], false)).toBeNull();
	});
});
