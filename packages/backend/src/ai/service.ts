import type { CompatibleRepository } from "./compatible";
import { fetchCompatibleModels, NO_CONNECTION } from "./compatible";
import type { CompatibleService } from "./types";

const URL_MAX = 300;
const API_KEY_MAX = 300;

/** 末尾の / を外す。パスを足して使うため */
function normalizeBaseUrl(raw: string): string | null {
	const t = raw.trim().replace(/\/+$/, "");
	if (t.length > URL_MAX) return null;
	try {
		const u = new URL(t);
		return u.protocol === "http:" || u.protocol === "https:" ? t : null;
	} catch {
		return null;
	}
}

export function createCompatibleService({
	repo,
	onSaved = () => {},
	listModels = fetchCompatibleModels,
	now = Date.now,
}: {
	repo: CompatibleRepository;
	/** 接続先を保存したとき。前の接続先で失敗した採点をやり直すのに使う */
	onSaved?: () => void;
	listModels?: typeof fetchCompatibleModels;
	now?: () => number;
}): CompatibleService {
	return {
		status: () => {
			const c = repo.connection();
			return {
				baseUrl: c?.baseUrl ?? null,
				keyConfigured: !!c?.apiKey,
				keySavedAt: c?.apiKey ? repo.keySavedAt() : null,
			};
		},

		save({ baseUrl, apiKey }) {
			const url = normalizeBaseUrl(baseUrl);
			if (!url)
				return {
					ok: false,
					message: "URL は http:// か https:// で始まる形で入れる",
				};
			const k = apiKey?.trim();
			if (k !== undefined) {
				if (/\s/.test(k)) return { ok: false, message: "キーに空白を含めない" };
				if (k.length > API_KEY_MAX)
					return { ok: false, message: `キーは ${API_KEY_MAX} 文字以内にする` };
			}
			repo.save(url, k, now());
			onSaved();
			return { ok: true };
		},

		clear() {
			repo.clear();
		},

		async models() {
			const c = repo.connection();
			if (!c) return { ok: false, message: NO_CONNECTION };
			try {
				return { ok: true, models: await listModels(c) };
			} catch (e) {
				const message =
					e instanceof Error && e.name === "TimeoutError"
						? "OpenAI 互換の接続先から応答が無い"
						: e instanceof Error
							? e.message
							: String(e);
				return { ok: false, message };
			}
		},
	};
}
