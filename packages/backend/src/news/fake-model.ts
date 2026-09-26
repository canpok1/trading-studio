// テストと E2E で使う、Gemini の代わりに決まった点数を返す偽物

import type { ScoreModel } from "./gemini";

/** 見出しから決まる点数を返す。isDown が true の間は失敗する */
export function demoScoreModel({
	isDown = () => false,
}: {
	isDown?: () => boolean;
} = {}): ScoreModel {
	return {
		unavailable: () => null,
		async generate(_model, prompt) {
			if (isDown()) throw new Error("偽物の AI が止まっている（E2E）");
			const title = /見出し: (.*)/.exec(prompt)?.[1] ?? "";
			let h = 0;
			for (const ch of title)
				h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 1_000_003;
			return {
				trend: 30 + (h % 41),
				risk: h % 3 === 0 ? null : 20 + (h % 51),
				sentiment: 25 + (h % 51),
				comment: "デモの採点。",
			};
		},
	};
}
