import { describe, expect, test } from "bun:test";
import type { ConditionSet } from "@trading-studio/core";
import { strategyTemplate } from "@trading-studio/core";
import {
	parseSaved,
	strategyBb,
	strategyDvolAvg,
	strategyDvolLevels,
	strategyEma,
	strategyRsi,
	usesDvol,
	validBb,
	validDvolAvg,
	validEma,
	validRsi,
} from "./chart-indicators";

const base = strategyTemplate("blank").params;
const withBuy = (
	conditions: ConditionSet["buys"][number]["buy"]["conditions"],
): ConditionSet => ({
	...base,
	buys: base.buys.map((b) => ({
		...b,
		buy: { match: "all" as const, conditions },
	})),
});

describe("チャートの EMA・RSI の設定", () => {
	test("戦略で使っていなければ null", () => {
		expect(strategyEma(base)).toBeNull();
		expect(strategyRsi(base)).toBeNull();
		expect(strategyEma(null)).toBeNull();
	});

	test("EMA は戦略の本数を短い方から2本まで使う", () => {
		const p = withBuy([
			{
				type: "emaCross",
				timeframe: "1h",
				fast: 10,
				slow: 50,
				direction: "up",
			},
			{ type: "emaCross", timeframe: "1h", fast: 5, slow: 20, direction: "up" },
		]);
		expect(strategyEma(p)).toEqual([5, 10]);
	});

	test("RSI のしきい値が1つなら、もう片方は既定の値で補う", () => {
		expect(
			strategyRsi(
				withBuy([
					{
						type: "rsi",
						timeframe: "1h",
						period: 9,
						threshold: 25,
						direction: "below",
					},
				]),
			),
		).toEqual({ period: 9, lower: 25, upper: 70 });
		expect(
			strategyRsi(
				withBuy([
					{
						type: "rsi",
						timeframe: "1h",
						period: 9,
						threshold: 80,
						direction: "above",
					},
				]),
			),
		).toEqual({ period: 9, lower: 30, upper: 80 });
	});

	test("RSI のしきい値が2つ以上なら最小と最大を使う", () => {
		const buyOnly = withBuy([
			{
				type: "rsi",
				timeframe: "1h",
				period: 14,
				threshold: 20,
				direction: "below",
			},
		]);
		const p: ConditionSet = {
			...buyOnly,
			buys: buyOnly.buys.map((b) => ({
				...b,
				takeProfit: {
					match: "all",
					conditions: [
						{
							type: "rsi",
							timeframe: "1h",
							period: 14,
							threshold: 75,
							direction: "above",
						},
					],
				},
			})),
		};
		expect(strategyRsi(p)).toEqual({ period: 14, lower: 20, upper: 75 });
	});

	test("入力の検査", () => {
		expect(validEma([20])).toBe(true);
		expect(validEma([20, 50])).toBe(true);
		expect(validEma([20, 20])).toBe(false);
		expect(validEma([1])).toBe(false);
		expect(validEma([5, 10, 20])).toBe(false);
		expect(validEma([])).toBe(false);
		expect(validRsi({ period: 14, lower: 30, upper: 70 })).toBe(true);
		expect(validRsi({ period: 14, lower: 70, upper: 30 })).toBe(false);
		expect(validRsi({ period: 1, lower: 30, upper: 70 })).toBe(false);
	});

	test("保存した値は壊れた項目だけ捨てる", () => {
		expect(parseSaved(null)).toEqual({
			ema: undefined,
			rsi: undefined,
			bb: undefined,
		});
		expect(parseSaved("{")).toEqual({});
		expect(
			parseSaved(
				JSON.stringify({
					ema: [9, 21],
					rsi: { period: 0, lower: 1, upper: 2 },
					bb: { period: 20, sigma: 2.5 },
				}),
			),
		).toEqual({ ema: [9, 21], rsi: undefined, bb: { period: 20, sigma: 2.5 } });
	});

	test("ボリンジャーバンドは戦略の本数が短い方を使い、σ は 0.1 刻み", () => {
		expect(strategyBb(base)).toBeNull();
		expect(
			strategyBb(
				withBuy([
					{
						type: "bollinger",
						timeframe: "1h",
						period: 30,
						sigma: 2,
						band: "lower",
					},
					{
						type: "bollinger",
						timeframe: "1h",
						period: 20,
						sigma: 2.5,
						band: "lower",
					},
				]),
			),
		).toEqual({ period: 20, sigma: 2.5 });
		expect(validBb({ period: 20, sigma: 2 })).toBe(true);
		expect(validBb({ period: 20, sigma: 2.05 })).toBe(false);
		expect(validBb({ period: 1, sigma: 2 })).toBe(false);
		expect(validBb({ period: 20, sigma: 6 })).toBe(false);
	});
});

describe("チャートの DVOL の平均", () => {
	const avg = (days: number, percent: number, direction: "above" | "below") =>
		({ type: "dvolAverage", days, percent, direction }) as const;

	test("戦略で使っていなければ null・空", () => {
		expect(strategyDvolAvg(base)).toBeNull();
		expect(strategyDvolLevels(base)).toEqual([]);
		expect(usesDvol(base)).toBe(false);
		expect(usesDvol(null)).toBe(false);
	});

	test("日数は短い方、% はその日数の条件の最小と最大", () => {
		const p = withBuy([
			avg(30, 130, "below"),
			avg(14, 110, "below"),
			avg(14, 160, "above"),
		]);
		expect(strategyDvolAvg(p)).toEqual({ days: 14, lower: 110, upper: 160 });
		expect(usesDvol(p)).toBe(true);
	});

	test("% が1つなら、150 より下なら下側、それ以外は上側に置き、もう片方は既定", () => {
		expect(strategyDvolAvg(withBuy([avg(30, 90, "below")]))).toEqual({
			days: 30,
			lower: 90,
			upper: 150,
		});
		expect(strategyDvolAvg(withBuy([avg(30, 200, "above")]))).toEqual({
			days: 30,
			lower: 120,
			upper: 200,
		});
	});

	test("値の条件はしきい値を小さい順・重複なしで返し、平均は持たない", () => {
		const p = withBuy([
			{ type: "dvol", threshold: 70, direction: "above" },
			{ type: "dvol", threshold: 45.5, direction: "below" },
			{ type: "dvol", threshold: 70, direction: "below" },
		]);
		expect(strategyDvolLevels(p)).toEqual([45.5, 70]);
		expect(strategyDvolAvg(p)).toBeNull();
		expect(usesDvol(p)).toBe(true);
	});

	test("入力の検査と保存した値の読み込み", () => {
		expect(validDvolAvg({ days: 30, lower: 120, upper: 150 })).toBe(true);
		expect(validDvolAvg({ days: 31, lower: 120, upper: 150 })).toBe(false);
		expect(validDvolAvg({ days: 30, lower: 150, upper: 150 })).toBe(false);
		expect(validDvolAvg({ days: 30, lower: 0, upper: 150 })).toBe(false);
		expect(
			parseSaved(
				JSON.stringify({ dvolAvg: { days: 7, lower: 80, upper: 140 } }),
			).dvolAvg,
		).toEqual({ days: 7, lower: 80, upper: 140 });
		expect(parseSaved(JSON.stringify({ dvolAvg: { days: 0 } })).dvolAvg).toBe(
			undefined,
		);
	});
});
