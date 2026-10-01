import { describe, expect, test } from "bun:test";
import type { ConditionSet } from "@trading-studio/core";
import { strategyTemplate } from "@trading-studio/core";
import {
	parseSaved,
	strategyBb,
	strategyEma,
	strategyRsi,
	validBb,
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
