// AI のモデルへの問い合わせの型と、モデルの選び方。実装は Gemini 直結（news/gemini-infra.ts）と OpenAI 互換（compatible-infra.ts）

/** Gemini の構造化出力の形（responseSchema の書き方） */
export type ResponseSchema = Record<string, unknown>;

/** モデルへ1回問い合わせ、応答の JSON を返す。テストと E2E では偽物に差し替える */
export type GeminiModel = {
	/** そのモデルを使えない理由（API キーが無いなど）。使えれば null */
	unavailable(model: string): string | null;
	generate(
		model: string,
		prompt: string,
		schema: ResponseSchema,
	): Promise<unknown>;
};
/** 採点に使うモデル。名前は採点の側から見たもの */
export type ScoreModel = GeminiModel;

/** 画面で選べるモデル（docs/adr/0008）。先頭が既定 */
export const SCORING_MODELS = [
	{ id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
	{ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
	{ id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro（プレビュー）" },
] as const;
export const DEFAULT_SCORING_MODEL = SCORING_MODELS[0].id;

export type CompatibleConnection = { baseUrl: string; apiKey: string | null };

/** OpenAI 互換の接続先のモデルに付ける印。Gemini 直結のモデル名と区別し、記録にもこの形で残す */
export const COMPATIBLE_PREFIX = "openai:";

export const isCompatibleModel = (id: string) =>
	id.startsWith(COMPATIBLE_PREFIX);

const MODEL_ID_MAX = 200;

/**
 * 選べるモデルか。OpenAI 互換のモデルは接続先の一覧を取らないと確かめられないので、形だけ見る。
 * 一覧を取れないときも保存済みの選択を変えずに済むようにするため
 */
export const isSelectableModel = (
	fixed: readonly { id: string }[],
	id: string,
) =>
	fixed.some((m) => m.id === id) ||
	(isCompatibleModel(id) &&
		id.length > COMPATIBLE_PREFIX.length &&
		id.length <= MODEL_ID_MAX &&
		!/\s/.test(id));

export const NO_CONNECTION =
	"OpenAI 互換の接続先が設定されていない。設定画面の「全般」で設定する";
