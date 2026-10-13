// 採点のプロンプトと、AI の応答の検証。ひな形と出力形式は集計の前提なので固定する

import type { Duration, Scores } from "@trading-studio/core";
import { DURATIONS, JUDGES, SCORE_RANGES } from "@trading-studio/core";

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
まず duration を決め、次に観点ごとの整数を付ける。
- duration: 相場への影響が続く長さ。none=BTC/JPY の相場に関係ない / short=数時間（発言・話題・単発の値動き） / medium=1日程度（企業や取引所の発表・ETF の資金の出入り） / long=数日以上（規制・金融政策・大規模な流出）
- sentiment: -100〜100。BTC の価格にとって強気材料か弱気材料か。-100=強い弱気材料（下落要因） / 0=中立 / 100=強い強気材料（上昇要因）
- risk: 0〜100。0=安全 / 100=危険
duration が none なら sentiment と risk は 0 にする。それ以外でも関係ない観点は 0 にする。
comment には採点の理由を日本語で書く。

JSON のみを出力: {"duration": "none"|"short"|"medium"|"long", "sentiment": 整数, "risk": 整数, "comment": 文字列}`;

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
		sentiment: {
			type: "INTEGER",
			minimum: SCORE_RANGES.sentiment.min,
			maximum: SCORE_RANGES.sentiment.max,
		},
		risk: {
			type: "INTEGER",
			minimum: SCORE_RANGES.risk.min,
			maximum: SCORE_RANGES.risk.max,
		},
		duration: { type: "STRING", format: "enum", enum: [...DURATIONS] },
		comment: { type: "STRING" },
	},
	required: ["duration", "sentiment", "risk", "comment"],
	propertyOrdering: ["duration", "sentiment", "risk", "comment"],
} as const;

export const COMMENT_MAX = 1000;

export type ScoreResponse = {
	scores: Scores;
	duration: Duration;
	comment: string;
};

/** 応答を検証する。形が合わなければ理由の文字列を返す */
export function parseScoreResponse(v: unknown): ScoreResponse | string {
	if (typeof v !== "object" || v === null || Array.isArray(v)) {
		return "応答が JSON のオブジェクトでない";
	}
	const o = v as Record<string, unknown>;
	const scores = {} as Scores;
	for (const j of JUDGES) {
		const x = o[j];
		const { min, max } = SCORE_RANGES[j];
		if (Number.isInteger(x) && (x as number) >= min && (x as number) <= max) {
			scores[j] = x as number;
		} else {
			return `${j} が ${min}〜${max} の整数でない: ${JSON.stringify(x) ?? "なし"}`;
		}
	}
	const duration = o.duration;
	if (!DURATIONS.includes(duration as Duration)) {
		return `duration が ${DURATIONS.join("・")} のどれでもない: ${JSON.stringify(duration) ?? "なし"}`;
	}
	if (typeof o.comment !== "string" || o.comment.trim() === "") {
		return "comment が空";
	}
	// 関係ない記事の点数は 0 にそろえる（AI が点数を付けても集計には使わないため）
	if (duration === "none") {
		for (const j of JUDGES) scores[j] = 0;
	}
	return {
		scores,
		duration: duration as Duration,
		comment: o.comment.trim().slice(0, COMMENT_MAX),
	};
}
