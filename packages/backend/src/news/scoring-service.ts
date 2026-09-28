import { DEFAULT_SCORING_MODEL, SCORING_MODELS } from "./gemini";
import { PROMPT_TEMPLATE } from "./prompt";
import type { NewsRepository } from "./repository";
import type { ScoreRepository } from "./score-repository";
import type { Scorer } from "./scorer";
import type { ScoringService, TrialItem } from "./types";
import { TRIAL_MAX_NEWS } from "./types";

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
	scorer: Pick<Scorer, "problem" | "trial" | "clearFailure">;
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
			// 前のキーで失敗したものは、新しいキーで採点し直す
			repo.retryAllFailed(now());
			scorer.clearFailure();
			return { ok: true };
		},

		deleteApiKey() {
			repo.deleteApiKey();
			scorer.clearFailure();
		},

		retry: (newsId) => repo.requestRetry(newsId, now()),

		async trial(criteria, newsIds) {
			const t = criteria.trim();
			if (!t) return { ok: false, message: "採点の基準を入れる" };
			if (newsIds && newsIds.length > TRIAL_MAX_NEWS)
				return { ok: false, message: `記事は ${TRIAL_MAX_NEWS} 件までにする` };
			const targets =
				newsIds && newsIds.length > 0
					? newsRepo.newsByIds([...new Set(newsIds)])
					: newsRepo.listNews(1);
			if (targets.length === 0)
				return {
					ok: false,
					message: newsIds?.length
						? "ニュースが見つからない"
						: "ニュースがまだ無い",
				};
			const items: TrialItem[] = [];
			for (const n of targets) {
				const r = await scorer.trial(n, t);
				items.push({
					news: {
						id: n.id,
						title: n.title,
						sourceName: n.sourceName,
						publishedAt: n.publishedAt,
						stored:
							n.score?.status === "done" && n.score.scores
								? {
										scores: n.score.scores,
										comment: n.score.comment,
										criteriaVersion: n.score.criteriaVersion,
									}
								: null,
					},
					result: r.ok
						? { ok: true, ...r.result }
						: { ok: false, message: r.error },
				});
			}
			return { ok: true, items };
		},
	};
}
