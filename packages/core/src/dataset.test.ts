import { describe, expect, test } from "bun:test";
import type { BacktestSummary } from "./backtest";
import {
	overlappingPairs,
	pickSpreadSegments,
	summarizeDataset,
} from "./dataset";

const summary = (over: Partial<BacktestSummary>): BacktestSummary => ({
	initialCash: 1_000_000,
	finalEquity: 1_000_000,
	pnl: 0,
	pnlPercent: 0,
	trades: 0,
	wins: 0,
	losses: 0,
	winRate: null,
	profitFactor: null,
	maxDrawdownPercent: 0,
	maxDrawdownFrom: null,
	maxDrawdownTo: null,
	buyHoldPercent: 0,
	averageHoldingMs: null,
	openPositionQuantity: 0,
	...over,
});

describe("summarizeDataset", () => {
	test("取引はまとめて数え、損益は平均と最悪で出す", () => {
		const s = summarizeDataset([
			{
				regime: "up",
				summary: summary({
					pnlPercent: 4,
					buyHoldPercent: 10,
					trades: 2,
					maxDrawdownPercent: 3,
				}),
				tradePnls: [300, -100],
			},
			{
				regime: "range",
				summary: summary({
					pnlPercent: -2,
					buyHoldPercent: -5,
					trades: 1,
					maxDrawdownPercent: 8,
				}),
				tradePnls: [-200],
			},
			{
				regime: "range",
				summary: summary({ pnlPercent: 1, buyHoldPercent: 1 }),
				tradePnls: [],
			},
		]);
		expect(s).toMatchObject({
			count: 3,
			trades: 3,
			wins: 1,
			losses: 2,
			profitFactor: 1,
			averagePnlPercent: 1,
			worstPnlPercent: -2,
			averageBuyHoldPercent: 2,
			maxDrawdownPercent: 8,
			beatBuyHold: 2,
			idle: false,
			byRegime: [
				{ regime: "up", count: 1, averagePnlPercent: 4 },
				{ regime: "range", count: 2, averagePnlPercent: -0.5 },
			],
		});
		expect(s?.winRate).toBeCloseTo(33.33, 1);
	});

	test("損失が無ければ PF は null、取引も保有も無ければ何もしていない扱い", () => {
		const s = summarizeDataset([
			{ regime: "down", summary: summary({}), tradePnls: [] },
		]);
		expect(s).toMatchObject({
			trades: 0,
			winRate: null,
			profitFactor: null,
			idle: true,
		});
		expect(summarizeDataset([])).toBeNull();
	});

	test("ガチホを持たない結果があれば、ガチホの平均は出さない", () => {
		const s = summarizeDataset([
			{
				regime: "up",
				summary: summary({ buyHoldPercent: undefined }),
				tradePnls: [],
			},
		]);
		expect(s?.averageBuyHoldPercent).toBeNull();
		expect(s?.beatBuyHold).toBe(0);
	});
});

const M = 30;
// 新しい順。月 m から2か月
const ds = (list: [number, "up" | "down" | "range" | "volatile"][]) =>
	list.map(([m, regime], i) => ({
		id: i + 1,
		from: m * M,
		to: (m + 2) * M,
		regime,
	}));

describe("pickSpreadSegments", () => {
	test("相場ごとに重ならないものを新しい順に選び、少ない相場を先に選ぶ", () => {
		const list = ds([
			[8, "range"],
			[7, "volatile"],
			[6, "range"],
			[5, "up"],
			[3, "range"],
		]);
		const picked = pickSpreadSegments(list, 1);
		// 乱高下（7〜9月）を先に選ぶので、レンジは重ならない 3月になる
		expect(picked.map((d) => [d.from / M, d.regime])).toEqual([
			[7, "volatile"],
			[5, "up"],
			[3, "range"],
		]);
		expect(pickSpreadSegments(list, 2).map((d) => d.from / M)).toEqual([
			7, 5, 3,
		]);
	});
});

describe("overlappingPairs", () => {
	test("期間が重なる組を返す。接するだけなら重ならない", () => {
		expect(
			overlappingPairs([
				{ from: 0, to: 2 },
				{ from: 1, to: 3 },
				{ from: 3, to: 5 },
			]),
		).toEqual([[0, 1]]);
	});
});

test("同じ入力で2回実行すると結果が一致する", () => {
	const list = ds([
		[8, "range"],
		[7, "volatile"],
		[5, "up"],
		[3, "range"],
	]);
	expect(pickSpreadSegments(list, 2)).toEqual(pickSpreadSegments(list, 2));
	const members = list.map((d, i) => ({
		regime: d.regime,
		summary: summary({ pnlPercent: i - 1, trades: 1 }),
		tradePnls: [i * 100 - 100],
	}));
	expect(summarizeDataset(members)).toEqual(summarizeDataset(members));
});
