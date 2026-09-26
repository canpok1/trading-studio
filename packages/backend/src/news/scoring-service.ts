import { DEFAULT_SCORING_MODEL, SCORING_MODELS } from "./gemini";
import { PROMPT_TEMPLATE } from "./prompt";
import type { NewsRepository } from "./repository";
import type { ScoreRepository } from "./score-repository";
import type { Scorer } from "./scorer";
import type { ScoringService } from "./types";

export const CRITERIA_MAX = 4000;
const NOTE_MAX = 100;
const API_KEY_MAX = 200;

export function createScoringService({
	repo,
	newsRepo,
	scorer,
	now = Date.now,
}: {
	repo: ScoreRepository;
	newsRepo: NewsRepository;
	scorer: Pick<Scorer, "problem" | "trial">;
	now?: () => number;
}): ScoringService {
	const isModel = (id: string) => SCORING_MODELS.some((m) => m.id === id);
	return {
		status() {
			const p = scorer.problem();
			return {
				state: p ? "stopped" : "running",
				error: p?.error ?? null,
				stoppedSince: p?.since ?? null,
				model: repo.model(DEFAULT_SCORING_MODEL),
				activeCriteriaVersion: repo.activeCriteriaVersion(),
				pending: repo.pendingCount(),
			};
		},

		criteria: () => ({
			versions: repo.listCriteria(),
			activeVersion: repo.activeCriteriaVersion(),
			template: PROMPT_TEMPLATE,
		}),

		addCriteria(text, note) {
			const t = text.trim();
			if (!t) return { ok: false, message: "採点の基準を入れる" };
			if (t.length > CRITERIA_MAX)
				return { ok: false, message: `${CRITERIA_MAX} 文字以内にする` };
			const n = note.trim().slice(0, NOTE_MAX) || "画面から編集";
			return { ok: true, version: repo.addCriteria(t, n, now()) };
		},

		setActiveCriteria(version) {
			if (!repo.getCriteria(version)) return false;
			repo.setActiveCriteria(version);
			return true;
		},

		models: () => ({
			models: SCORING_MODELS.map((m) => ({ id: m.id, label: m.label })),
			current: repo.model(DEFAULT_SCORING_MODEL),
		}),

		setModel(id) {
			if (!isModel(id)) return false;
			repo.setModel(id);
			return true;
		},

		apiKey: () => ({
			configured: repo.apiKey() !== null,
			savedAt: repo.apiKeySavedAt(),
		}),

		setApiKey(key) {
			const k = key.trim();
			if (!k) return { ok: false, message: "API キーを入れる" };
			if (/\s/.test(k)) return { ok: false, message: "空白を含めない" };
			if (k.length > API_KEY_MAX)
				return { ok: false, message: `${API_KEY_MAX} 文字以内にする` };
			repo.setApiKey(k, now());
			return { ok: true };
		},

		deleteApiKey: () => repo.deleteApiKey(),

		retry: (newsId) => repo.requestRetry(newsId, now()),

		async trial(criteria) {
			const t = criteria.trim();
			if (!t) return { ok: false, message: "採点の基準を入れる" };
			const latest = newsRepo.listNews(1)[0];
			if (!latest) return { ok: false, message: "ニュースがまだ無い" };
			const r = await scorer.trial(latest, t);
			if (!r.ok) return { ok: false, message: r.error };
			return {
				ok: true,
				news: {
					id: latest.id,
					title: latest.title,
					sourceName: latest.sourceName,
				},
				scores: r.result.scores,
				comment: r.result.comment,
			};
		},
	};
}
