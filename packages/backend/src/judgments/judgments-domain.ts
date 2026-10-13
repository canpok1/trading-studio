import type { AggregationRule, Timeframe } from "@trading-studio/core";
import {
	isTimeframe,
	JUDGES,
	judgeAt,
	judgmentBreakdown,
	judgmentRecordStart,
	judgmentSeries,
	maxWindowMs,
	parseAggregationRule,
	TIMEFRAME_MS,
	validateAggregationRule,
} from "@trading-studio/core";

import type { JudgmentRepository } from "./repository-domain";
import type {
	CurrentJudgment,
	JudgmentSeries,
	JudgmentService,
} from "./types-domain";

/** 一度に返す足の上限。チャートの足の上限（5万本）に余裕を持たせる */
const MAX_SERIES = 100_000;

/** 足ごとの評価を求める期間と足の粒度の入力を確かめる */
export function parseSeriesQuery(
	q: Record<string, unknown>,
):
	| { ok: true; from: number; to: number; timeframe: Timeframe }
	| { ok: false; message: string } {
	const from = Number(q.from);
	const to = Number(q.to);
	if (!isTimeframe(q.timeframe))
		return { ok: false, message: "足の粒度を選ぶ" };
	if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) {
		return { ok: false, message: "期間の形が違う" };
	}
	const step = TIMEFRAME_MS[q.timeframe];
	if ((to - from) / step > MAX_SERIES) {
		return { ok: false, message: `足が多すぎる（上限 ${MAX_SERIES}本）` };
	}
	return { ok: true, from, to, timeframe: q.timeframe };
}

/** { rule } の形の入力から評価ルールを取り出す。形が違えば null（値の範囲は確かめない） */
export function parseRuleInput(v: unknown): AggregationRule | null {
	return parseAggregationRule(
		typeof v === "object" && v !== null && "rule" in v ? v.rule : null,
	);
}

export function createJudgmentService({
	repo,
	newsDelayMs,
	now = Date.now,
}: {
	repo: JudgmentRepository;
	/** バックテストで記事を使い始めるまでの遅れ（取得の間隔） */
	newsDelayMs: () => number;
	now?: () => number;
}): JudgmentService {
	const recordStart = (segmentFrom: number | null = null) =>
		judgmentRecordStart(
			repo.firstScoredAt(),
			repo.newsDeletedBefore(),
			segmentFrom,
		);
	const service: JudgmentService = {
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
				firstScoredAt: recordStart(),
			};
		},
		series(
			from,
			to,
			step,
			rule = repo.aggregationRule(),
			version = null,
			delayMs = null,
			segmentFrom = null,
		): JudgmentSeries {
			const t = now();
			const firstScoredAt = recordStart(segmentFrom);
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
		seriesOf: (from, to, timeframe) =>
			service.series(from, to, TIMEFRAME_MS[timeframe]),
		rule: () => repo.aggregationRule(),
		firstScoredAt: (segmentFrom) => recordStart(segmentFrom),
		scoredNews: (from, to, version, delayMs) =>
			repo.scoredNews(from, to, version, delayMs),
		newsDelayMs,
		newsDataVersion: (from, to, version, delayMs) =>
			repo.newsDataVersion(from, to, version, delayMs),
		preview(rule) {
			const errors = validateAggregationRule(rule);
			return errors.length
				? { ok: false, errors }
				: { ok: true, judgment: service.current(rule) };
		},
		saveRule(rule) {
			const errors = validateAggregationRule(rule);
			if (errors.length) return { ok: false, errors };
			repo.setAggregationRule(rule);
			return { ok: true };
		},
	};
	return service;
}
