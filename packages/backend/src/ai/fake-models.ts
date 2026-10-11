// テストと E2E で使う、OpenAI 互換の接続先の代わりに決まったモデル一覧を返す偽物

import type { CompatibleConnection } from "./compatible";
import { COMPATIBLE_PREFIX } from "./compatible";
import type { CompatibleModelOption } from "./types";

export const DEMO_COMPATIBLE_MODELS = [
	"anthropic/claude-demo",
	"gemini/gemini-demo",
	"openai/gpt-demo",
	"openai/gpt-demo-mini",
];

export async function demoCompatibleModels(
	_c: CompatibleConnection,
): Promise<CompatibleModelOption[]> {
	return DEMO_COMPATIBLE_MODELS.map((id) => ({
		id: `${COMPATIBLE_PREFIX}${id}`,
		label: id,
	}));
}
