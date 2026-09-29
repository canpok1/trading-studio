import { describe, expect, test } from "bun:test";
import type { ConditionSet } from "./condition-strategy";
import { DEFAULT_BUY_ORDER } from "./condition-strategy";
import { conditionSetChanges } from "./screen-text";

const BASE: ConditionSet = {
	timeframe: "1h",
	frequency: {
		flat: { value: 1, unit: "h" },
		holding: { value: 1, unit: "h" },
	},
	orderSize: 1_000_000,
	maxPositions: 1,
	dailyLossLimit: 30_000,
	buy: {
		match: "all",
		conditions: [{ type: "emaCross", fast: 12, slow: 48, direction: "up" }],
	},
	buyOrder: DEFAULT_BUY_ORDER,
	takeProfit: {
		match: "any",
		conditions: [{ type: "entryChange", percent: 5, direction: "up" }],
	},
	stopLoss: { match: "any", conditions: [] },
};

describe("戦略設定の変更点", () => {
	test("同じなら無い", () => {
		expect(conditionSetChanges(BASE, structuredClone(BASE))).toEqual([]);
	});

	test("値を変えた条件は、変える前と後の行で出す", () => {
		const after = structuredClone(BASE);
		after.buy.conditions[0] = {
			type: "emaCross",
			fast: 20,
			slow: 48,
			direction: "up",
		};
		after.maxPositions = 3;
		expect(conditionSetChanges(BASE, after)).toEqual([
			{
				section: "注文量とロット数",
				removed: ["最大ロット数: 1"],
				added: ["最大ロット数: 3"],
			},
			{
				section: "買い注文する条件",
				removed: ["短期EMA 12 本が 長期EMA 48 本を上抜けた"],
				added: ["短期EMA 20 本が 長期EMA 48 本を上抜けた"],
			},
		]);
	});

	test("先頭に条件を足しても、残りの条件は変わったことにしない。組み合わせ方の変更も出す", () => {
		const after = structuredClone(BASE);
		after.takeProfit = {
			match: "all",
			conditions: [
				{ type: "rsi", period: 14, threshold: 70, direction: "above" },
				...BASE.takeProfit.conditions,
			],
		};
		after.stopLoss.conditions = [{ type: "trailingStop", percent: 3 }];
		expect(conditionSetChanges(BASE, after)).toEqual([
			{
				section: "売り注文（利確）する条件",
				removed: ["組み合わせ方: どれか1つ"],
				added: ["組み合わせ方: すべて満たす", "RSI 14 本が 70 以上"],
			},
			{
				section: "売り注文（損切り）する条件",
				removed: ["条件なし"],
				added: ["買ってからの最高値から 3% 下がった"],
			},
		]);
	});
});
