import { judgeAt, validateAggregationRule } from "@trading-studio/core";
import type { ScoreRepository } from "../news/score-repository";
import type { CurrentJudgment, JudgmentService } from "./types";

export function createJudgmentService({
	repo,
	now = Date.now,
}: {
	repo: ScoreRepository;
	now?: () => number;
}): JudgmentService {
	return {
		current(rule = repo.aggregationRule()): CurrentJudgment {
			const t = now();
			// 期間内のニュースは採点時刻も期間内にある（採点は取得より後、取得は公開より後か同時のため）
			const news = repo.scoredNews(t - rule.windowHours * 3_600_000, t + 1);
			const s = judgeAt(news, t, rule);
			return {
				time: t,
				rule,
				results: s.results,
				weights: Object.fromEntries(s.weights),
				firstScoredAt: repo.firstScoredAt(),
			};
		},
		rule: () => repo.aggregationRule(),
		saveRule(rule) {
			const errors = validateAggregationRule(rule);
			if (errors.length) return { ok: false, errors };
			repo.setAggregationRule(rule);
			return { ok: true };
		},
	};
}
