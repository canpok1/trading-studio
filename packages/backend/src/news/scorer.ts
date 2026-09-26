// ニュースの採点の常駐処理。新着を1件ずつ Gemini で採点し、点数を記録する

import type { AggregationRule } from "@trading-studio/core";
import type { ScoreModel } from "./gemini";
import { DEFAULT_SCORING_MODEL } from "./gemini";
import type { PromptNews, ScoreResponse } from "./prompt";
import { buildPrompt, parseScoreResponse } from "./prompt";
import type { ScoreRepository } from "./score-repository";

/** 自動の再試行の間隔。3回まで延ばしながら再試行し、それでも失敗なら止めて手動の再試行を待つ */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;

/** 無料枠の回数制限（1分あたり十数回）に当たらないよう、問い合わせの間を空ける */
const MIN_INTERVAL_MS = 5_000;

export type Scorer = {
	/** 定期的に呼ぶ（main では1秒ごと）。採点していないニュースがあれば1件採点する */
	tick(): void;
	/** 動いている採点の終わりを待つ（テスト用） */
	idle(): Promise<void>;
	/** 採点が止まっている理由といつからか。止まっていなければ null */
	problem(): { error: string; since: number } | null;
	/** 保存も集計への反映もせずに採点する（試し採点） */
	trial(
		news: PromptNews,
		criteria: string,
	): Promise<
		{ ok: true; result: ScoreResponse } | { ok: false; error: string }
	>;
};

export function createScorer({
	repo,
	model,
	rule,
	now = Date.now,
	minIntervalMs = MIN_INTERVAL_MS,
	retryDelaysMs = RETRY_DELAYS_MS,
}: {
	repo: ScoreRepository;
	model: ScoreModel;
	/** 集計の期間より古い記事は採点しない（集計に入らないため） */
	rule: () => AggregationRule;
	now?: () => number;
	/** 採点の問い合わせの最短の間隔 */
	minIntervalMs?: number;
	/** 自動の再試行の間隔。回数はこの長さ */
	retryDelaysMs?: readonly number[];
}): Scorer {
	let running: Promise<void> | null = null;
	/** 直近の採点が続けて失敗している間の、最初の失敗 */
	let failing: { error: string; since: number } | null = null;
	let noKeySince: number | null = null;
	let lastAskedAt = Number.NEGATIVE_INFINITY;

	async function ask(news: PromptNews, criteria: string, modelId: string) {
		const raw = await model.generate(modelId, buildPrompt(news, criteria));
		const parsed = parseScoreResponse(raw);
		if (typeof parsed === "string")
			throw new Error(`応答の形が違う: ${parsed}`);
		return parsed;
	}

	async function scoreNext() {
		repo.skipOlderThan(now() - rule().windowHours * 3_600_000);
		const next = repo.nextToScore(now());
		if (!next) return;
		const version = repo.activeCriteriaVersion();
		const criteria = version === null ? null : repo.getCriteria(version);
		if (!criteria) throw new Error("使用中の採点の基準が無い");
		const modelId = repo.model(DEFAULT_SCORING_MODEL);
		lastAskedAt = now();
		try {
			const r = await ask(next, criteria.text, modelId);
			repo.saveScore(next.id, r, {
				scoredAt: now(),
				criteriaVersion: criteria.version,
				model: modelId,
				attempts: next.attempts,
			});
			failing = null;
		} catch (e) {
			const error = e instanceof Error ? e.message : String(e);
			const attempts = next.attempts + 1;
			const delay = retryDelaysMs[attempts - 1];
			repo.saveFailure(
				next.id,
				error,
				attempts,
				delay === undefined ? null : now() + delay,
			);
			failing = { error, since: failing?.since ?? now() };
		}
	}

	return {
		tick() {
			if (running) return;
			if (model.unavailable()) {
				noKeySince ??= now();
				return;
			}
			noKeySince = null;
			if (now() - lastAskedAt < minIntervalMs) return;
			running = scoreNext()
				.catch((e) => {
					// ニュースごとの失敗ではなく採点そのものが進めない。止まっていると状態に出す
					console.error("scorer: failed", e);
					const error = e instanceof Error ? e.message : String(e);
					failing = { error, since: failing?.since ?? now() };
				})
				.finally(() => {
					running = null;
				});
		},
		idle: () => running ?? Promise.resolve(),
		problem() {
			const reason = model.unavailable();
			if (reason) return { error: reason, since: noKeySince ?? now() };
			return failing
				? {
						error: `採点に失敗している: ${failing.error}`,
						since: failing.since,
					}
				: null;
		},
		async trial(news, criteria) {
			const reason = model.unavailable();
			if (reason) return { ok: false, error: reason };
			try {
				return {
					ok: true,
					result: await ask(news, criteria, repo.model(DEFAULT_SCORING_MODEL)),
				};
			} catch (e) {
				return { ok: false, error: e instanceof Error ? e.message : String(e) };
			}
		},
	};
}
