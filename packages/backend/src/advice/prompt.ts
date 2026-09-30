// アドバイスのプロンプトと、AI の応答の検証。ひな形と出力形式は画面の見出しの前提なので固定する

import type { ResponseSchema } from "../news/gemini";
import { IMPROVED_STRATEGY_SCHEMA } from "./improved";
import type { AdviceContent } from "./types";

/** ひな形。{backtest} と {instructions} を差し込む。長い資料を先頭に、指示を最後に置く */
export const ADVICE_TEMPLATE = `<backtest>
{backtest}
</backtest>

<instructions>
{instructions}
</instructions>

# 依頼
<backtest> は BTC/JPY の自動売買の戦略を、過去データで模擬売買した結果です。<instructions> に従って、結果を分析し、戦略の改善案を出してください。

# 出力（この形式以外は受け付けない）
すべて日本語。見出しや記号での装飾はせず、項目が複数あるときは「- 」で始まる箇条書きにする。
- analysis: 結果の分析
- good: うまくいった点
- bad: 悪かった点
- improvements: 改善案。変える項目と具体的な値を書く
- improvedStrategy: improvements の戦略設定の変更をすべて反映した後の戦略設定。improvements で変えない項目は <backtest> の戦略設定の値をそのまま写す。期間・口座・評価ルールは含めない

improvements の文章では、設定の変更を利用者が画面でそのまま設定し直せるよう、<backtest> に書いた画面の見出しと項目名で書く。例: 「買い注文する条件」の「短期EMA」を 12 本から 20 本にする。プログラムの項目名・JSON・添字（conditions[0] など）は使わない

JSON のみを出力: {"analysis": 文字列, "good": 文字列, "bad": 文字列, "improvements": 文字列, "improvedStrategy": 戦略設定}`;

/** 指示の初版 */
export const DEFAULT_INSTRUCTIONS = `- 損益だけでなく、最大ドローダウン・取引回数も踏まえて評価する
- 負けた取引は、注文の前後の値動きから原因を考える
- 取引回数が少なく偶然の可能性が高いときは、そう書く
- 改善案は効果が大きそうな順に 3 つまで`;

export function buildAdvicePrompt(backtest: string, instructions: string) {
	// 差し込む値に {instructions} などが含まれていても二重に置き換えないよう、1回で置き換える
	return ADVICE_TEMPLATE.replace(
		/\{(backtest|instructions)\}/g,
		(_, k: string) => (k === "backtest" ? backtest : instructions),
	);
}

/**
 * チャット型の AI へコピペで渡すときに足す説明。Gemini には構造化出力で渡している
 * 改善版の戦略設定の形を、文章で伝える
 */
export function buildExternalAdvicePrompt(
	backtest: string,
	instructions: string,
) {
	return `${buildAdvicePrompt(backtest, instructions)}

# improvedStrategy の形
次の JSON Schema に従う。description が画面の項目との対応。使わない項目は null にする。
${JSON.stringify(IMPROVED_STRATEGY_SCHEMA)}

回答は JSON だけにする。前後に説明文を付けない。`;
}

/**
 * 利用者が貼ったチャット型 AI の答えから JSON を取り出す。
 * コードブロックの囲みや前後の説明文が混ざっても、最初の { から最後の } までを読む
 */
export function extractAdviceJson(text: string): unknown {
	const from = text.indexOf("{");
	const to = text.lastIndexOf("}");
	if (from < 0 || to < from) throw new Error("貼った答えに JSON が無い");
	try {
		return JSON.parse(text.slice(from, to + 1));
	} catch {
		throw new Error("貼った答えの JSON を読めない");
	}
}

const KEYS = ["analysis", "good", "bad", "improvements"] as const;
type TextKey = (typeof KEYS)[number];

/** 構造化出力で強制する形（Gemini の responseSchema の書き方） */
export const ADVICE_RESPONSE_SCHEMA: ResponseSchema = {
	type: "OBJECT",
	properties: {
		...Object.fromEntries(KEYS.map((k) => [k, { type: "STRING" }])),
		improvedStrategy: IMPROVED_STRATEGY_SCHEMA,
	},
	required: [...KEYS, "improvedStrategy"],
	propertyOrdering: [...KEYS, "improvedStrategy"],
};

/** 見出しの文章を検証する。形が違えば理由を投げる。改善版の戦略は readImprovedStrategy で読む */
export function parseAdviceResponse(
	raw: unknown,
): Pick<AdviceContent, TextKey> {
	if (typeof raw !== "object" || raw === null) {
		throw new Error("AI の応答がオブジェクトでない");
	}
	const r = raw as Record<string, unknown>;
	const out: Partial<Pick<AdviceContent, TextKey>> = {};
	for (const k of KEYS) {
		const v = r[k];
		if (typeof v !== "string" || v.trim() === "") {
			throw new Error(`AI の応答に ${k} が無い`);
		}
		out[k] = v.trim();
	}
	return out as Pick<AdviceContent, TextKey>;
}
