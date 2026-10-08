import {
	JUDGES,
	judgeAt,
	judgmentBreakdown,
	judgmentSeries,
	maxWindowMs,
	validateAggregationRule,
} from "@trading-studio/core";
import type { ScoreRepository } from "../news/score-repository";
import type { CurrentJudgment, JudgmentSeries, JudgmentService } from "./types";

export function createJudgmentService({
	repo,
	newsDelayMs,
	now = Date.now,
}: {
	repo: ScoreRepository;
	/** バックテストで記事を使い始めるまでの遅れ（取得の間隔） */
	newsDelayMs: () => number;
	now?: () => number;
}): JudgmentService {
	return {
		current(rule = repo.aggregationRule(), at?: number): CurrentJudgment {
			// 先の時刻は今として扱う
			const t = at === undefined ? now() : Math.min(at, now());
			// 集計に使うニュースは使い始める時刻もその長さの内にある（使い始める時刻は新しさの時刻より後か同時のため）
			const news = repo.scoredNews(t - maxWindowMs(rule), t + 1);
			const s = judgeAt(news, t, rule);
			return {
				time: t,
				rule,
				results: s.results,
				weights: Object.fromEntries(s.weights),
				breakdown: judgmentBreakdown(news, s.weights, rule),
				firstScoredAt: repo.firstScoredAt(),
			};
		},
		series(
			from,
			to,
			step,
			rule = repo.aggregationRule(),
			version = null,
			delayMs = null,
		): JudgmentSeries {
			const t = now();
			const firstScoredAt = repo.firstScoredAt();
			const count = Math.max(0, Math.ceil((to - from) / step));
			// 足の終わりの時刻で判定する。まだ終わっていない足は今の判定
			const times = Array.from({ length: count }, (_, i) =>
				Math.min(from + (i + 1) * step, t),
			);
			const values = {
				sentiment: [],
				risk: [],
			} as JudgmentSeries["values"];
			const judged =
				firstScoredAt === null
					? []
					: judgmentSeries(
							// 集計に使うニュースは使い始める時刻もその長さの内にある（current と同じ理由）
							repo.scoredNews(
								from - maxWindowMs(rule),
								to + 1,
								version,
								delayMs,
							),
							times,
							rule,
						);
			times.forEach((time, i) => {
				const p = judged[i];
				for (const j of JUDGES) {
					const v =
						p && firstScoredAt !== null && time >= firstScoredAt
							? p.values[j]
							: null;
					(values[j] as unknown[]).push(v);
				}
			});
			return { from, step, firstScoredAt, values };
		},
		rule: () => repo.aggregationRule(),
		firstScoredAt: () => repo.firstScoredAt(),
		scoredNews: (from, to, version, delayMs) =>
			repo.scoredNews(from, to, version, delayMs),
		newsDelayMs,
		newsDataVersion: (from, to, version, delayMs) =>
			repo.newsDataVersion(from, to, version, delayMs),
		saveRule(rule) {
			const errors = validateAggregationRule(rule);
			if (errors.length) return { ok: false, errors };
			repo.setAggregationRule(rule);
			return { ok: true };
		},
	};
}
