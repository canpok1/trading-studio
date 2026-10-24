// テストと E2E で使う、Gemini の代わりに決まった点数を返す偽物。予定の重要度の判断にも答える

import type { ScoreModel } from "../ai/model-domain";

/** 見出しから決まる点数を返す（見出しに ETH・XRP があればその銘柄の個別の点数も）。予定には件名で重要度を返す（FOMC・CPI・雇用統計・日銀は高、PPI は中、ほかは低） */
export function demoScoreModel(): ScoreModel {
	return {
		unavailable: () => null,
		async generate(_model, prompt) {
			if (prompt.startsWith("<event>")) {
				const title = /件名: (.*)/.exec(prompt)?.[1] ?? "";
				const importance = /FOMC|CPI|雇用統計|日銀|Non-Farm/i.test(title)
					? "high"
					: /PPI/i.test(title)
						? "medium"
						: "low";
				return { importance, reason: "デモの判断。" };
			}
			const title = /見出し: (.*)/.exec(prompt)?.[1] ?? "";
			let h = 0;
			for (const ch of title)
				h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 1_000_003;
			const sentiment = -40 + 2 * (h % 41);
			const risk = h % 3 === 0 ? 0 : 20 + (h % 51);
			return {
				sentiment,
				risk,
				duration: "short",
				// 見出しに ETH・XRP があれば、その銘柄に個別の点数（市場全体と向きを逆に）を付ける
				instruments: ["ETH", "XRP"]
					.filter((s) => title.includes(s))
					.map((s) => ({
						symbol: `${s}/JPY`,
						sentiment: -sentiment,
						risk,
						duration: "short",
					})),
				comment: "デモの採点。",
			};
		},
	};
}
