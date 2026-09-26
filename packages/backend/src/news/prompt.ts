// 採点のプロンプトと、AI の応答の検証。ひな形と出力形式は集計の前提なので固定する

import type { Scores } from "@trading-studio/core";
import { JUDGES } from "@trading-studio/core";

/** ひな形。{news} と {criteria} を差し込む。長い文書を先頭に、指示を最後に置く */
export const PROMPT_TEMPLATE = `<news>
{news}
</news>

<criteria>
{criteria}
</criteria>

# 依頼
<news> のニュース1件が BTC/JPY の相場に与える影響を、<criteria> の基準で採点してください。

# 出力（この形式以外は受け付けない）
観点ごとに 0〜100 の整数。関係ない観点は null。
- trend: 0=強い下落要因 / 50=中立 / 100=強い上昇要因
- risk: 0=安全 / 100=危険
- sentiment: 0=強い悲観 / 100=強い楽観
comment には採点の理由を日本語で書く。

JSON のみを出力: {"trend": 整数|null, "risk": 整数|null, "sentiment": 整数|null, "comment": 文字列}`;

/** 採点の基準の初版 */
export const DEFAULT_CRITERIA = `- 価格そのものの推移ではなく、ニュースの材料で判断する
- 取引所の障害・規制・ハッキングはリスクを高くする
- 要人発言や指標発表の前後はリスクをやや高くする
- comment には採点の理由を 2 文までで書く`;

export type PromptNews = {
	sourceName: string;
	title: string;
	summary: string | null;
	publishedAt: number;
};

function jst(time: number): string {
	return `${new Date(time + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ")} JST`;
}

export function buildPrompt(news: PromptNews, criteria: string): string {
	const body = [
		`情報源: ${news.sourceName}`,
		`公開時刻: ${jst(news.publishedAt)}`,
		`見出し: ${news.title}`,
		...(news.summary ? [`概要: ${news.summary}`] : []),
	].join("\n");
	// 差し込む値に {criteria} などが含まれていても二重に置き換えないよう、1回で置き換える
	return PROMPT_TEMPLATE.replace(/\{(news|criteria)\}/g, (_, k: string) =>
		k === "news" ? body : criteria,
	);
}

/** 構造化出力で強制する形（Gemini の responseSchema の書き方） */
export const RESPONSE_SCHEMA = {
	type: "OBJECT",
	properties: {
		trend: { type: "INTEGER", nullable: true, minimum: 0, maximum: 100 },
		risk: { type: "INTEGER", nullable: true, minimum: 0, maximum: 100 },
		sentiment: { type: "INTEGER", nullable: true, minimum: 0, maximum: 100 },
		comment: { type: "STRING" },
	},
	required: ["trend", "risk", "sentiment", "comment"],
	propertyOrdering: ["trend", "risk", "sentiment", "comment"],
} as const;

export const COMMENT_MAX = 1000;

export type ScoreResponse = { scores: Scores; comment: string };

/** 応答を検証する。形が合わなければ理由の文字列を返す */
export function parseScoreResponse(v: unknown): ScoreResponse | string {
	if (typeof v !== "object" || v === null || Array.isArray(v)) {
		return "応答が JSON のオブジェクトでない";
	}
	const o = v as Record<string, unknown>;
	const scores = {} as Scores;
	for (const j of JUDGES) {
		const x = o[j];
		if (x === null) {
			scores[j] = null;
		} else if (
			Number.isInteger(x) &&
			(x as number) >= 0 &&
			(x as number) <= 100
		) {
			scores[j] = x as number;
		} else {
			return `${j} が 0〜100 の整数か null でない: ${JSON.stringify(x) ?? "なし"}`;
		}
	}
	if (typeof o.comment !== "string" || o.comment.trim() === "") {
		return "comment が空";
	}
	return { scores, comment: o.comment.trim().slice(0, COMMENT_MAX) };
}
