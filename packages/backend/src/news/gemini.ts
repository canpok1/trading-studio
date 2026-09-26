// Gemini API（generateContent）で採点する。構造化出力で JSON の形を強制する

import { RESPONSE_SCHEMA } from "./prompt";

/** 採点に使うモデルへ1回問い合わせ、応答の JSON を返す。テストと E2E では偽物に差し替える */
export type ScoreModel = {
	/** 使えない理由（API キーが無いなど）。使えれば null */
	unavailable(): string | null;
	generate(model: string, prompt: string): Promise<unknown>;
};

/** 画面で選べるモデル（docs/adr/0008）。先頭が既定 */
export const SCORING_MODELS = [
	{ id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
	{ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
	{ id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro（プレビュー）" },
] as const;
export const DEFAULT_SCORING_MODEL = SCORING_MODELS[0].id;

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = 60_000;

export const NO_API_KEY =
	"API キーが設定されていない。設定画面の「収集と採点」で設定する";

/** キーは画面から保存・削除されるので、問い合わせのたびに読む */
export function geminiModel(apiKey: () => string | null): ScoreModel {
	return {
		unavailable: () => (apiKey() ? null : NO_API_KEY),
		async generate(model, prompt) {
			const key = apiKey();
			if (!key) throw new Error(NO_API_KEY);
			const res = await fetch(
				`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`,
				{
					method: "POST",
					signal: AbortSignal.timeout(TIMEOUT_MS),
					headers: {
						"content-type": "application/json",
						"x-goog-api-key": key,
					},
					body: JSON.stringify({
						contents: [{ role: "user", parts: [{ text: prompt }] }],
						generationConfig: {
							responseMimeType: "application/json",
							responseSchema: RESPONSE_SCHEMA,
						},
					}),
				},
			);
			const body = (await res.json().catch(() => null)) as {
				error?: { message?: string };
				candidates?: {
					finishReason?: string;
					content?: { parts?: { text?: string }[] };
				}[];
			} | null;
			if (!res.ok) {
				throw new Error(
					`Gemini API ${res.status}: ${body?.error?.message ?? res.statusText}`,
				);
			}
			const c = body?.candidates?.[0];
			const text = c?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
			if (!text) {
				throw new Error(
					`Gemini API の応答が空（${c?.finishReason ?? "理由不明"}）`,
				);
			}
			try {
				return JSON.parse(text);
			} catch {
				throw new Error("Gemini API の応答が JSON でない");
			}
		},
	};
}
