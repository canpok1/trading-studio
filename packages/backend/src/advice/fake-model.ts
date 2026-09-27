// テストと E2E で使う、Gemini の代わりに決まったアドバイスを返す偽物

import type { GeminiModel } from "../news/gemini";

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
				improvements: "- orderSize を 1000000 にする",
			};
		},
	};
}
