// テストと E2E で使う、Gemini の代わりに決まった点数を返す偽物

import type { ScoreModel } from "../ai/model-domain";

/** 見出しから決まる点数を返す */
export function demoScoreModel(): ScoreModel {
	return {
		unavailable: () => null,
		async generate(_model, prompt) {
			const title = /見出し: (.*)/.exec(prompt)?.[1] ?? "";
			let h = 0;
			for (const ch of title)
				h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 1_000_003;
			return {
				sentiment: -40 + 2 * (h % 41),
				risk: h % 3 === 0 ? 0 : 20 + (h % 51),
				duration: "short",
				comment: "デモの採点。",
			};
		},
	};
}
