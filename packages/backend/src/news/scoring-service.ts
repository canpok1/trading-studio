import { maxWindowMs } from "@trading-studio/core";
import { DEFAULT_SCORING_MODEL, SCORING_MODELS } from "./gemini";
import { PROMPT_TEMPLATE } from "./prompt";
import type { NewsRepository } from "./repository";
import type { ScoreRepository } from "./score-repository";
import type { Scorer } from "./scorer";
import type {
	LiveRescoreResult,
	RescoreResult,
	ScoringService,
	TrialItem,
} from "./types";
import { TRIAL_MAX_NEWS } from "./types";

export const CRITERIA_MAX = 4000;
/** 絞り込みの条件でまとめて採点し直せる件数の上限（ニュース画面で読み込める件数と同じ） */
export const LIVE_RESCORE_MAX = 1000;
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
	const checkRescore = (
		from: number,
		to: number,
		version: number,
	): RescoreResult | null => {
		if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to)
			return { ok: false, status: 400, message: "期間の形が違う" };
		if (!Number.isSafeInteger(version) || !repo.getCriteria(version))
			return { ok: false, status: 404, message: "版が見つからない" };
		return null;
	};
	/** 期間 [from, to) の市場評価に使う記事の採点時刻の範囲。期間の頭では評価ルールで集計に使う一番長い長さだけ前までの記事を使う */
	const usedBy = (from: number, to: number): [number, number] => [
		from - maxWindowMs(repo.aggregationRule()),
		to,
	];
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
				rescorePending: repo.liveRescorePending(),
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

		rescoreCoverage(from, to, version) {
			const bad = checkRescore(from, to, version);
			if (bad) return bad;
			return {
				ok: true,
				coverage: repo.rescoreCoverage(...usedBy(from, to), version),
			};
		},

		requestRescore(from, to, version) {
			const bad = checkRescore(from, to, version);
			if (bad) return bad;
			repo.queueRescore(...usedBy(from, to), version, now());
			return {
				ok: true,
				coverage: repo.rescoreCoverage(...usedBy(from, to), version),
			};
		},

		rescoreLive(target): LiveRescoreResult {
			const version = repo.activeCriteriaVersion();
			if (version === null || !repo.getCriteria(version))
				return { ok: false, status: 409, message: "使用中の採点の基準が無い" };
			let ids: number[];
			if ("newsId" in target) {
				ids = [target.newsId];
			} else {
				const found = newsRepo.searchNews(
					{ ...target.filter, limit: LIVE_RESCORE_MAX },
					repo.aggregationRule(),
				);
				if (found.total > LIVE_RESCORE_MAX)
					return {
						ok: false,
						status: 400,
						message: `${LIVE_RESCORE_MAX} 件までに絞る`,
					};
				ids = found.news.map((n) => n.id);
			}
			const requested = repo.requestReplace(ids, version, now());
			return {
				ok: true,
				version,
				requested,
				skipped: ids.length - requested,
			};
		},

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
										duration: n.score.duration ?? "short",
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
