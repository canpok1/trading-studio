import { describe, expect, test } from "bun:test";
import type { ConditionSet, SingleBuyConditionSet } from "@trading-studio/core";
import {
	DEFAULT_BUY_ORDER,
	DEFAULT_PARTIAL_SELL,
	singleBuy,
} from "@trading-studio/core";
import { DEMO_IMPROVED_STRATEGY } from "./fake-model-infra";
import { readImprovedStrategy } from "./improved-domain";

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

describe("改善版の戦略", () => {
	// PARAMS を AI の出す形にしたもの。使わない項目は null で埋めてくる。patch は買い1つめに当てる
	const ai = (patch: Record<string, unknown> = {}) => ({
		frequency: PARAMS.frequency,
		dailyLossLimitYen: 30_000,
		stopLossCooldownBars: 0,
		stopLossCooldownTimeframe: "1h",
		buys: [
			{
				id: "b1",
				name: "買い1",
				orderSizeBtc: 0.01,
				maxPositions: 1,
				buy: {
					match: "all",
					conditions: [
						{
							type: "breakout",
							timeframe: "1h",
							lookback: 5,
							direction: "high",
							fast: null,
							values: null,
						},
					],
				},
				buyOrder: {
					lines: [{ type: "limit", belowPercent: 0.1 }],
					expireBars: 3,
					expireTimeframe: "1h",
				},
				partialTakeProfit: { match: "all", conditions: [] },
				partialSell: DEFAULT_PARTIAL_SELL,
				takeProfit: FLAT.takeProfit,
				stopLoss: FLAT.stopLoss,
				...patch,
			},
		],
	});

	test("null の項目を落とし、注文量は BTC から satoshi に直して読む", () => {
		const r = readImprovedStrategy(ai({ orderSizeBtc: 0.02 }), PARAMS);
		expect(r).toEqual({
			ok: true,
			params: singleBuy({ ...FLAT, orderSize: 2_000_000 }),
		});
	});

	test("設定として正しくなければ、アドバイスは残して理由を返す", () => {
		const r = readImprovedStrategy(ai({ maxPositions: 0 }), PARAMS);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("設定として正しくない");
		expect(readImprovedStrategy(ai({ buy: { match: "x" } }), PARAMS)).toEqual({
			ok: false,
			reason: "AI の出した改善版の戦略の形が正しくない",
		});
		expect(readImprovedStrategy(undefined, PARAMS)).toEqual({
			ok: false,
			reason: "AI の応答に改善版の戦略が無い",
		});
	});

	test("元の戦略と変わらなければ使えない", () => {
		expect(readImprovedStrategy(ai(), PARAMS)).toEqual({
			ok: false,
			reason: "改善案に戦略設定の変更が無い",
		});
	});

	test("偽物の AI の出す戦略は設定として正しい", () => {
		expect(readImprovedStrategy(DEMO_IMPROVED_STRATEGY, PARAMS).ok).toBe(true);
	});
});
