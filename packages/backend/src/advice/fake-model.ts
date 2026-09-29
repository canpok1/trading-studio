// テストと E2E で使う、Gemini の代わりに決まったアドバイスを返す偽物

import type { GeminiModel } from "../news/gemini";

/** 偽物が出す改善版の戦略。決まった値なので、元の戦略と同じなら「変更なし」になる */
export const DEMO_IMPROVED_STRATEGY = {
	timeframe: "1h",
	frequency: {
		flat: { value: 1, unit: "h" },
		holding: { value: 1, unit: "h" },
	},
	orderSizeBtc: 0.001,
	maxPositions: 1,
	dailyLossLimitYen: 100000,
	buy: {
		match: "all",
		conditions: [{ type: "emaCross", fast: 12, slow: 48, direction: "up" }],
	},
	buyOrder: { lines: [{ type: "market" }], expireBars: 3 },
	takeProfit: {
		match: "any",
		conditions: [{ type: "entryChange", percent: 5, direction: "up" }],
	},
	stopLoss: {
		match: "any",
		conditions: [{ type: "entryChange", percent: 3, direction: "down" }],
	},
};

/** プロンプトの注文の件数を書き込んだアドバイスを返す。isDown が true の間は失敗する */
export function demoAdviceModel({
	isDown = () => false,
}: {
	isDown?: () => boolean;
} = {}): GeminiModel {
	return {
		unavailable: () => null,
		async generate(_model, prompt) {
			if (isDown()) throw new Error("偽物の AI が止まっている（E2E）");
			const orders = /## 注文（(\d+) 件/.exec(prompt)?.[1] ?? "?";
			return {
				analysis: `デモの分析。注文は ${orders} 件。`,
				good: "- デモのうまくいった点",
				bad: "- デモの悪かった点",
				improvements:
					"- 「売り注文（損切り）する条件」に「買値から 3% 下がった」を足す",
				improvedStrategy: DEMO_IMPROVED_STRATEGY,
			};
		},
	};
}
