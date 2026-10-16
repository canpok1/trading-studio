// 予定の重要度を判断するプロンプトと、AI の応答の検証。ひな形と出力形式は条件の前提なので固定し、評価基準だけを編集できる

import type { EventImportance } from "@trading-studio/core";
import { EVENT_IMPORTANCES, isEventImportance } from "@trading-studio/core";

/** ひな形。{event} と {criteria} を差し込む */
export const EVENT_PROMPT_TEMPLATE = `<event>
{event}
</event>

<criteria>
{criteria}
</criteria>

# 依頼
<event> の予定1件の重要度を、<criteria> の基準で判断してください。

# 出力（この形式以外は受け付けない）
- importance: high=高 / medium=中 / low=低
- reason: 判断の理由を日本語で 1 文で書く

JSON のみを出力: {"importance": "high"|"medium"|"low", "reason": 文字列}`;

/** 予定の評価基準の初版 */
export const DEFAULT_EVENT_CRITERIA = `BTC/JPY の値動きへの影響の大きさで判断する。
- high: 発表の前後で BTC/JPY が大きく動きうる。米国の政策金利の発表（FOMC 声明）、FOMC 議事要旨、米 CPI、米雇用統計、日銀の金融政策決定会合、FRB 議長の発言など
- medium: 動くことがあるが high ほどではない。米 PPI、米小売売上高、米 GDP、米 PCE 物価指数など
- low: BTC/JPY への影響はほとんど無い。米国と日本以外の指標、要人の講演、祝日など
- 取得元の重要度（Impact など）は経済全体での目安で、BTC/JPY への影響とは限らない。参考にとどめる`;

export type PromptEvent = {
	sourceName: string;
	title: string;
	description: string | null;
	start: number;
	allDay: boolean;
};

/** 説明は長いと判断の材料より飾りが増えるので、先頭だけ渡す */
const DESCRIPTION_MAX = 500;

/** 日時（JST）。終日の予定は JST の日の 0:00 で持つので日付だけ */
function when(e: PromptEvent): string {
	const s = new Date(e.start + 9 * 3_600_000).toISOString();
	return e.allDay
		? `${s.slice(0, 10)}（終日）`
		: `${s.slice(0, 16).replace("T", " ")} JST`;
}

export function buildEventPrompt(event: PromptEvent, criteria: string): string {
	const description = event.description?.trim().slice(0, DESCRIPTION_MAX);
	const body = [
		`取得元: ${event.sourceName}`,
		`日時: ${when(event)}`,
		`件名: ${event.title}`,
		...(description ? [`説明: ${description}`] : []),
	].join("\n");
	// 差し込む値に {criteria} などが含まれていても二重に置き換えないよう、1回で置き換える
	return EVENT_PROMPT_TEMPLATE.replace(
		/\{(event|criteria)\}/g,
		(_, k: string) => (k === "event" ? body : criteria),
	);
}

/** 構造化出力で強制する形（Gemini の responseSchema の書き方） */
export const EVENT_RESPONSE_SCHEMA = {
	type: "OBJECT",
	properties: {
		importance: {
			type: "STRING",
			format: "enum",
			enum: [...EVENT_IMPORTANCES],
		},
		reason: { type: "STRING" },
	},
	required: ["importance", "reason"],
	propertyOrdering: ["importance", "reason"],
} as const;

const REASON_MAX = 500;

export type EventJudgeResponse = {
	importance: EventImportance;
	reason: string;
};

/** 応答を検証する。形が合わなければ理由の文字列を返す */
export function parseEventResponse(v: unknown): EventJudgeResponse | string {
	if (typeof v !== "object" || v === null || Array.isArray(v)) {
		return "応答が JSON のオブジェクトでない";
	}
	const o = v as Record<string, unknown>;
	if (!isEventImportance(o.importance)) {
		return `importance が ${EVENT_IMPORTANCES.join("・")} のどれでもない: ${JSON.stringify(o.importance) ?? "なし"}`;
	}
	if (typeof o.reason !== "string" || o.reason.trim() === "") {
		return "reason が空";
	}
	return {
		importance: o.importance,
		reason: o.reason.trim().slice(0, REASON_MAX),
	};
}
