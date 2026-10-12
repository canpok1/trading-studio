// モデルの選択欄（ModelPicker）の絞り込み。Gemini 直結の固定一覧と OpenAI 互換の接続先から取った一覧を並べる

export type ModelOption = { id: string; label: string };

export type ModelGroup = { name: string; models: ModelOption[] };

/** OpenAI 互換のモデルの印。backend の COMPATIBLE_PREFIX と同じ */
const COMPATIBLE_PREFIX = "openai:";

export const isCompatibleId = (id: string) => id.startsWith(COMPATIBLE_PREFIX);

/** 印を外したモデルの名前。Gemini 直結はそのまま */
export const compatibleName = (id: string) =>
	isCompatibleId(id) ? id.slice(COMPATIBLE_PREFIX.length) : id;

/** 選択中のモデルの表示名。一覧を取れないときも ID から出す */
export function modelLabel(groups: ModelGroup[], id: string): string {
	for (const g of groups) {
		const m = g.models.find((x) => x.id === id);
		if (m) return isCompatibleId(id) ? `${m.label}（OpenAI 互換）` : m.label;
	}
	return isCompatibleId(id)
		? `${id.slice(COMPATIBLE_PREFIX.length)}（OpenAI 互換）`
		: id;
}

/** 空白で区切った語をすべて含むモデルだけ残す。大文字・小文字は区別しない */
export function filterModels(
	groups: ModelGroup[],
	query: string,
): ModelGroup[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return groups.map((g) => ({
		...g,
		models: g.models.filter((m) => {
			const label = m.label.toLowerCase();
			return words.every((w) => label.includes(w));
		}),
	}));
}
