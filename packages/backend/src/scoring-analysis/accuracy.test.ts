import { describe, expect, test } from "bun:test";
import { DEFAULT_AGGREGATION_RULE } from "@trading-studio/core";
import type { ScoredWithReturn } from "./accuracy";
import { accuracyByVersion } from "./accuracy";

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
	sentiment,
	risk,
	comment: null,
	returnPct,
});

describe("accuracyByVersion", () => {
	test("強弱の材料の当たり・中立の帯・リスクの空振りを数える", () => {
		const { versions } = accuracyByVersion(
			[
				row(1, 1, 30, 15, 1), // 強気で上昇: 当たり
				row(2, 1, -25, 15, 1), // 弱気で上昇: 外れ
				row(3, 1, 40, 15, null), // 値動きが無いので数えない
				row(4, 1, 15, 15, -2), // 中立の帯
				row(5, 1, 0, 75, 0.5), // 0 は中立の帯に数えない。警戒以上で値動きは平均より小さい
				row(6, 1, null, null, 3),
			],
			DEFAULT_AGGREGATION_RULE,
			1,
		);
		expect(versions).toHaveLength(1);
		const v = versions[0];
		expect(v).toMatchObject({
			version: 1,
			articles: 6,
			sentiment: {
				scored: 5,
				nulls: 1,
				positive: 3,
				neutralBand: 1,
				directed: 2,
				hits: 1,
			},
			risk: {
				scored: 5,
				nulls: 1,
				mode: { score: 15, count: 4 },
				high: 1,
				highMeanAbsPct: 0.5,
				// 値動きのある 1,2,4,5,6 の平均: (1+1+2+0.5+3)/5
				baseMeanAbsPct: 1.5,
			},
		});
		expect(v?.misses.items.map((x) => x.id)).toEqual([2]);
		expect(v?.neutral.items.map((x) => x.id)).toEqual([4]);
		expect(v?.calmRisk.items.map((x) => x.id)).toEqual([5]);
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
		);
		expect(versions.map((v) => v.version)).toEqual([2, 1]);
		expect(comparisons).toHaveLength(1);
		expect(comparisons[0]).toMatchObject({
			version: 1,
			common: 1,
			other: { articles: 1, sentiment: { directed: 1, hits: 0 } },
			active: { version: 2, articles: 1, sentiment: { directed: 1, hits: 1 } },
		});
	});
});
