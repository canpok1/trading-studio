// 戦略のひな形。新しい戦略を作るときの出発点で、作った後の戦略とは切り離される

import type { ConditionSet } from "./condition-strategy";

export const TEMPLATE_IDS = ["blank", "trend", "range"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export type StrategyTemplate = {
	name: string;
	description: string;
	params: ConditionSet;
};

const TEMPLATES: Record<TemplateId, StrategyTemplate> = {
	blank: {
		name: "空の戦略",
		description: "損切りの条件だけ入った状態から組み立てる。",
		params: {
			timeframe: "1h",
			frequency: {
				flat: { value: 1, unit: "h" },
				holding: { value: 15, unit: "m" },
			},
			orderSize: 1_000_000,
			buy: { match: "all", conditions: [] },
			takeProfit: { match: "any", conditions: [] },
			stopLoss: {
				match: "any",
				conditions: [{ type: "entryChange", percent: 2, direction: "down" }],
			},
		},
	},
	trend: {
		name: "トレンド追随",
		description: "上昇の流れに乗って買い、流れが変わったら売る。",
		params: {
			timeframe: "1h",
			frequency: {
				flat: { value: 1, unit: "h" },
				holding: { value: 15, unit: "m" },
			},
			orderSize: 2_000_000,
			buy: {
				match: "all",
				conditions: [{ type: "emaCross", fast: 12, slow: 48, direction: "up" }],
			},
			takeProfit: {
				match: "any",
				conditions: [
					{ type: "entryChange", percent: 4, direction: "up" },
					{ type: "emaCross", fast: 12, slow: 48, direction: "down" },
				],
			},
			stopLoss: {
				match: "any",
				conditions: [{ type: "entryChange", percent: 2, direction: "down" }],
			},
		},
	},
	range: {
		name: "レンジ逆張り",
		description: "直近の安値を割ったところで買い、戻したところで売る。",
		params: {
			timeframe: "1h",
			frequency: {
				flat: { value: 30, unit: "m" },
				holding: { value: 30, unit: "m" },
			},
			orderSize: 1_000_000,
			buy: {
				match: "all",
				conditions: [{ type: "breakout", lookback: 24, direction: "low" }],
			},
			takeProfit: {
				match: "any",
				conditions: [
					{ type: "entryChange", percent: 2, direction: "up" },
					{ type: "breakout", lookback: 24, direction: "high" },
				],
			},
			stopLoss: {
				match: "any",
				conditions: [{ type: "entryChange", percent: 1.5, direction: "down" }],
			},
		},
	},
};

/** ひな形の条件セット。呼び出し側が書き換えても元のひな形に影響しないよう複製して返す */
export function strategyTemplate(id: TemplateId): StrategyTemplate {
	return JSON.parse(JSON.stringify(TEMPLATES[id]));
}
