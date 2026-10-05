// 市場評価の精度。採点の版ごとに、点数とその後の値動き・点数の偏りを集計する（docs/news-page.md）

import type { AggregationRule } from "@trading-studio/core";
import { classify as judgmentOf } from "@trading-studio/core";
import type { VersionScoreRow } from "./repository";
import type {
	AccuracyList,
	AccuracyNews,
	LevelMatch,
	RiskBands,
	SentimentBands,
	VersionAccuracy,
	VersionComparison,
	VersionStats,
} from "./types";
import { ACCURACY_LIST_MAX } from "./types";

/** 版の採点に、採点時刻からの騰落率（%）を付けたもの */
export type ScoredWithReturn = VersionScoreRow & { returnPct: number | null };

/** 段階の判断に使う条件 */
export type AccuracyBands = { sentiment: SentimentBands; risk: RiskBands };

/** 値動きの5段階。-2 が大きく下落、2 が大きく上昇 */
export function moveLevel(pct: number, b: SentimentBands): number {
	const a = Math.abs(pct);
	const m = a < b.small ? 0 : a < b.large ? 1 : 2;
	return pct < 0 && m > 0 ? -m : m;
}

/** 値動きの大きさの3段階。0 が静か、1 が荒れた、2 が大荒れ */
export function roughLevel(pct: number, b: RiskBands): number {
	const a = Math.abs(pct);
	return a < b.rough ? 0 : a < b.wild ? 1 : 2;
}

const RISK_LEVEL = { normal: 0, caution: 1, crisis: 2 } as const;

/** 段階のずれから点数。一致で2点、1段ずれで1点 */
const pointsOf = (predicted: number, actual: number) =>
	Math.max(0, 2 - Math.abs(predicted - actual));

function levelMatch(
	pairs: readonly { predicted: number; actual: number }[],
	levels: readonly number[],
): LevelMatch {
	const by = levels.map((level) => ({ level, count: 0, points: 0 }));
	let exact = 0;
	let near = 0;
	for (const { predicted, actual } of pairs) {
		const p = pointsOf(predicted, actual);
		const l = by.find((x) => x.level === actual);
		if (l) {
			l.count++;
			l.points += p;
		}
		if (p === 2) exact++;
		else if (p === 1) near++;
	}
	const present = by.filter((l) => l.count > 0);
	return {
		levels: by,
		exact,
		near,
		miss: pairs.length - exact - near,
		rate:
			present.length === 0
				? null
				: (present.reduce((a, l) => a + l.points / (2 * l.count), 0) /
						present.length) *
					100,
	};
}

const SENTIMENT_LEVELS = [-2, -1, 0, 1, 2];
const RISK_LEVELS = [0, 1, 2];

function classify(
	rows: readonly ScoredWithReturn[],
	rule: AggregationRule,
	bands: AccuracyBands,
) {
	const t = rule.thresholds;
	const isDirected = (s: number) =>
		s >= t.sentiment.plus1 || s < t.sentiment.minus1;
	const sentimentPairs = rows.flatMap((r) =>
		r.sentiment === null || r.returnPct === null
			? []
			: [
					{
						row: r,
						predicted: Number(judgmentOf("sentiment", r.sentiment, rule)),
						actual: moveLevel(r.returnPct, bands.sentiment),
					},
				],
	);
	const sentimentMatch = levelMatch(sentimentPairs, SENTIMENT_LEVELS);
	const misses = sentimentPairs
		.filter((x) => pointsOf(x.predicted, x.actual) === 0)
		.map((x) => x.row);
	const neutral = rows.filter(
		(r) =>
			r.sentiment !== null && r.sentiment !== 0 && !isDirected(r.sentiment),
	);
	const riskPairs = rows.flatMap((r) =>
		r.risk === null || r.returnPct === null
			? []
			: [
					{
						row: r,
						predicted: RISK_LEVEL[judgmentOf("risk", r.risk, rule)],
						actual: roughLevel(r.returnPct, bands.risk),
					},
				],
	);
	return {
		sentimentMatch,
		misses,
		neutral,
		riskMatch: levelMatch(riskPairs, RISK_LEVELS),
		missedRisk: riskPairs
			.filter((x) => x.predicted < x.actual)
			.map((x) => x.row),
		falseAlarm: riskPairs
			.filter((x) => x.predicted > x.actual)
			.map((x) => x.row),
	};
}

function stats(
	version: number,
	rows: readonly ScoredWithReturn[],
	rule: AggregationRule,
	bands: AccuracyBands,
): VersionStats & { lists: ReturnType<typeof classify> } {
	const c = classify(rows, rule, bands);
	const sentiments = rows.flatMap((r) => r.sentiment ?? []);
	const risks = rows.flatMap((r) => r.risk ?? []);
	const counts = new Map<number, number>();
	for (const r of risks) counts.set(r, (counts.get(r) ?? 0) + 1);
	let mode: VersionStats["risk"]["mode"] = null;
	for (const [score, count] of counts) {
		// 同数なら小さい点数。張り付きは平常側で起きるため
		if (
			mode === null ||
			count > mode.count ||
			(count === mode.count && score < mode.score)
		)
			mode = { score, count };
	}
	return {
		version,
		articles: rows.length,
		sentiment: {
			scored: sentiments.length,
			nulls: rows.length - sentiments.length,
			positive: sentiments.filter((s) => s > 0).length,
			neutralBand: c.neutral.length,
			match: c.sentimentMatch,
		},
		risk: {
			scored: risks.length,
			nulls: rows.length - risks.length,
			mode,
			match: c.riskMatch,
		},
		lists: c,
	};
}

function list(rows: readonly ScoredWithReturn[]): AccuracyList {
	const items: AccuracyNews[] = [...rows]
		.sort((a, b) => b.publishedAt - a.publishedAt || b.id - a.id)
		.slice(0, ACCURACY_LIST_MAX)
		.map((r) => ({
			id: r.id,
			title: r.title,
			url: r.url,
			sourceName: r.sourceName,
			publishedAt: r.publishedAt,
			sentiment: r.sentiment,
			risk: r.risk,
			comment: r.comment,
			returnPct: r.returnPct,
		}));
	return { total: rows.length, items };
}

const strip = ({ lists: _, ...s }: ReturnType<typeof stats>): VersionStats => s;

/**
 * 版ごとの精度と、使用中の版とほかの版の同じ記事どうしの比較。
 * 使用中の版が無い（版が1つも無い）ときは、最も新しい版を比べる基準にする
 */
export function accuracyByVersion(
	rows: readonly ScoredWithReturn[],
	rule: AggregationRule,
	activeVersion: number | null,
	bands: AccuracyBands,
): { versions: VersionAccuracy[]; comparisons: VersionComparison[] } {
	const byVersion = new Map<number, ScoredWithReturn[]>();
	for (const r of rows) {
		const l = byVersion.get(r.version) ?? [];
		l.push(r);
		byVersion.set(r.version, l);
	}
	const order = [...byVersion.keys()].sort((a, b) => b - a);
	const versions = order.map((v) => {
		const s = stats(v, byVersion.get(v) ?? [], rule, bands);
		return {
			...strip(s),
			misses: list(s.lists.misses),
			neutral: list(s.lists.neutral),
			missedRisk: list(s.lists.missedRisk),
			falseAlarm: list(s.lists.falseAlarm),
		};
	});
	const base = activeVersion ?? order[0];
	const baseRows = base === undefined ? [] : (byVersion.get(base) ?? []);
	const baseIds = new Set(baseRows.map((r) => r.id));
	const comparisons = order
		.filter((v) => v !== base)
		.map((v) => {
			const other = (byVersion.get(v) ?? []).filter((r) => baseIds.has(r.id));
			const ids = new Set(other.map((r) => r.id));
			return {
				version: v,
				common: other.length,
				other: strip(stats(v, other, rule, bands)),
				active: strip(
					stats(
						base as number,
						baseRows.filter((r) => ids.has(r.id)),
						rule,
						bands,
					),
				),
			};
		});
	return { versions, comparisons };
}
