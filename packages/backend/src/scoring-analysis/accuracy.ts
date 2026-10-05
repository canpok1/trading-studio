// 市場評価の当たり具合。採点の版ごとに、点数とその後の値動き・点数の偏りを集計する（docs/news-page.md）

import type { AggregationRule } from "@trading-studio/core";
import type { VersionScoreRow } from "./repository";
import type {
	AccuracyList,
	AccuracyNews,
	VersionAccuracy,
	VersionComparison,
	VersionStats,
} from "./types";
import { ACCURACY_LIST_MAX } from "./types";

/** 版の採点に、採点時刻からの騰落率（%）を付けたもの */
export type ScoredWithReturn = VersionScoreRow & { returnPct: number | null };

const mean = (xs: number[]) =>
	xs.length === 0
		? null
		: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000;

function classify(rows: readonly ScoredWithReturn[], rule: AggregationRule) {
	const t = rule.thresholds;
	const isDirected = (s: number) =>
		s >= t.sentiment.plus1 || s < t.sentiment.minus1;
	const directed = rows.filter(
		(r) =>
			r.sentiment !== null &&
			isDirected(r.sentiment) &&
			r.returnPct !== null &&
			r.returnPct !== 0,
	);
	const misses = directed.filter(
		(r) => (r.sentiment as number) > 0 !== (r.returnPct as number) > 0,
	);
	const neutral = rows.filter(
		(r) =>
			r.sentiment !== null && r.sentiment !== 0 && !isDirected(r.sentiment),
	);
	const withReturn = rows.filter((r) => r.returnPct !== null);
	const baseMeanAbsPct = mean(
		withReturn.map((r) => Math.abs(r.returnPct as number)),
	);
	const high = withReturn.filter(
		(r) => r.risk !== null && r.risk >= t.risk.caution,
	);
	const calmRisk =
		baseMeanAbsPct === null
			? []
			: high.filter((r) => Math.abs(r.returnPct as number) < baseMeanAbsPct);
	return { directed, misses, neutral, high, baseMeanAbsPct, calmRisk };
}

function stats(
	version: number,
	rows: readonly ScoredWithReturn[],
	rule: AggregationRule,
): VersionStats & { lists: ReturnType<typeof classify> } {
	const c = classify(rows, rule);
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
			directed: c.directed.length,
			hits: c.directed.length - c.misses.length,
		},
		risk: {
			scored: risks.length,
			nulls: rows.length - risks.length,
			mode,
			high: c.high.length,
			highMeanAbsPct: mean(c.high.map((r) => Math.abs(r.returnPct as number))),
			baseMeanAbsPct: c.baseMeanAbsPct,
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
 * 版ごとの当たり具合と、使用中の版とほかの版の同じ記事どうしの比較。
 * 使用中の版が無い（版が1つも無い）ときは、最も新しい版を比べる基準にする
 */
export function accuracyByVersion(
	rows: readonly ScoredWithReturn[],
	rule: AggregationRule,
	activeVersion: number | null,
): { versions: VersionAccuracy[]; comparisons: VersionComparison[] } {
	const byVersion = new Map<number, ScoredWithReturn[]>();
	for (const r of rows) {
		const l = byVersion.get(r.version) ?? [];
		l.push(r);
		byVersion.set(r.version, l);
	}
	const order = [...byVersion.keys()].sort((a, b) => b - a);
	const versions = order.map((v) => {
		const s = stats(v, byVersion.get(v) ?? [], rule);
		return {
			...strip(s),
			misses: list(s.lists.misses),
			neutral: list(s.lists.neutral),
			calmRisk: list(s.lists.calmRisk),
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
				other: strip(stats(v, other, rule)),
				active: strip(
					stats(
						base as number,
						baseRows.filter((r) => ids.has(r.id)),
						rule,
					),
				),
			};
		});
	return { versions, comparisons };
}
