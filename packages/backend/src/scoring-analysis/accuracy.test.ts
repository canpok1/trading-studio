import { describe, expect, test } from "bun:test";
import { DEFAULT_AGGREGATION_RULE } from "@trading-studio/core";
import type { ScoredWithReturn } from "./accuracy";
import { accuracyByVersion, moveLevel, roughLevel } from "./accuracy";

const row = (
	id: number,
	version: number,
	sentiment: number | null,
	risk: number | null,
	returnPct: number | null,
): ScoredWithReturn => ({
	id,
	title: `記事${id}`,
	url: `https://a.example/${id}`,
	sourceName: "A",
	publishedAt: id * 1000,
	scoredAt: id * 1000,
	version,
	// 両方 null は相場に関係ない記事（持続 none）。片方だけ null はその観点を 0 点にする
	sentiment: sentiment ?? 0,
	risk: risk ?? 0,
	duration: sentiment === null && risk === null ? "none" : "short",
	comment: null,
	returnPct,
});

const BANDS = {
	sentiment: { small: 0.5, large: 2 },
	risk: { rough: 2, wild: 3 },
};

describe("値動きの段階", () => {
	test("センチメントと比べる5段階は、境目ちょうどを上の段階に入れる", () => {
		expect(
			[-2, -1.9, -0.5, -0.4, 0, 0.49, 0.5, 1.99, 2].map((p) =>
				moveLevel(p, BANDS.sentiment),
			),
		).toEqual([-2, -1, -1, 0, 0, 0, 1, 1, 2]);
	});
	test("リスクと比べる3段階は、上下を問わず大きさで分ける", () => {
		expect(
			[0, 1.99, 2, -2.5, 3, -4].map((p) => roughLevel(p, BANDS.risk)),
		).toEqual([0, 0, 1, 1, 2, 2]);
	});
});

describe("accuracyByVersion", () => {
	test("段階のずれで点を付け、値動きの段階ごとの平均点を平均する", () => {
		const { versions } = accuracyByVersion(
			[
				row(1, 1, 30, 15, 1), // やや強気・上昇: 2点。平常・静か: 2点
				row(2, 1, -25, 15, 1), // やや弱気・上昇: 0点。平常・静か: 2点
				row(3, 1, 40, 15, null), // 値動きが無いので数えない
				row(4, 1, 15, 15, -2.5), // 中立・大きく下落: 0点。平常・荒れた: 1点（見逃し）
				row(5, 1, 0, 75, 0.3), // 中立・横ばい: 2点。危機・静か: 0点（空振り）
				row(6, 1, null, null, 3), // 相場に関係ない（持続 none）ので数えない
				row(7, 1, null, 40, -3.5), // 中立（0点）・大きく下落: 0点。警戒・大荒れ: 1点（見逃し）
				row(8, 1, 70, null, 2.2), // かなり強気・大きく上昇: 2点。平常（0点）・荒れた: 1点（見逃し）
			],
			DEFAULT_AGGREGATION_RULE,
			1,
			BANDS,
		);
		expect(versions).toHaveLength(1);
		const v = versions[0];
		expect(v).toMatchObject({
			version: 1,
			articles: 8,
			sentiment: {
				scored: 7,
				nulls: 1,
				positive: 4,
				neutralBand: 1,
				match: {
					levels: [
						{ level: -2, count: 2, points: 0 },
						{ level: -1, count: 0, points: 0 },
						{ level: 0, count: 1, points: 2 },
						{ level: 1, count: 2, points: 2 },
						{ level: 2, count: 1, points: 2 },
					],
					exact: 3,
					near: 0,
					miss: 3,
				},
			},
			risk: {
				scored: 7,
				nulls: 1,
				mode: { score: 15, count: 4 },
				match: {
					levels: [
						{ level: 0, count: 3, points: 4 },
						{ level: 1, count: 2, points: 2 },
						{ level: 2, count: 1, points: 1 },
					],
					exact: 2,
					near: 3,
					miss: 1,
				},
			},
		});
		// 記事の無い段階（下落）は平均に入れない: (0 + 1 + 0.5 + 1) / 4
		expect(v?.sentiment.match.rate).toBeCloseTo(62.5);
		expect(v?.risk.match.rate).toBeCloseTo(((4 / 6 + 0.5 + 0.5) / 3) * 100);
		expect(v?.misses.items.map((x) => x.id)).toEqual([7, 4, 2]);
		expect(v?.neutral.items.map((x) => x.id)).toEqual([4]);
		expect(v?.missedRisk.items.map((x) => x.id)).toEqual([8, 7, 4]);
		expect(v?.falseAlarm.items.map((x) => x.id)).toEqual([5]);
	});

	test("使用中の版とほかの版を、両方で採点した記事だけで比べる", () => {
		const { versions, comparisons } = accuracyByVersion(
			[
				row(1, 1, 30, 50, 1),
				row(2, 1, 30, 50, -1),
				row(2, 2, -30, 15, -1),
				row(3, 2, 20, 15, 1),
			],
			DEFAULT_AGGREGATION_RULE,
			2,
			BANDS,
		);
		expect(versions.map((v) => v.version)).toEqual([2, 1]);
		expect(comparisons).toHaveLength(1);
		expect(comparisons[0]).toMatchObject({
			version: 1,
			common: 1,
			other: {
				articles: 1,
				sentiment: { match: { exact: 0, near: 0, miss: 1 } },
			},
			active: {
				version: 2,
				articles: 1,
				sentiment: { match: { exact: 1, near: 0, miss: 0 } },
			},
		});
	});
});
