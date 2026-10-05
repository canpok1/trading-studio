import { describe, expect, test } from "bun:test";
import type {
	AggregationRule,
	Duration,
	ScoredNews,
	Scores,
} from "./news-judgment";
import {
	classify,
	DEFAULT_AGGREGATION_RULE,
	DURATIONS,
	judgeAt,
	judgmentBands,
	judgmentSeries,
	newsTime,
	parseAggregationRule,
	validateAggregationRule,
} from "./news-judgment";

const H = 3_600_000;
const NOW = 1_000 * H;
const rule = DEFAULT_AGGREGATION_RULE;

function news(
	id: number,
	hoursAgo: number,
	scores: Partial<Scores>,
	over: Partial<ScoredNews> = {},
): ScoredNews {
	const t = NOW - hoursAgo * H;
	return {
		id,
		publishedAt: t,
		fetchedAt: t,
		scoredAt: t,
		scores: { sentiment: 0, risk: 0, ...scores },
		duration: "short",
		...over,
	};
}

describe("judgeAt", () => {
	test("半減期ちょうど前のニュースの重みは今の半分", () => {
		const s = judgeAt(
			[news(1, 0, { sentiment: 80 }), news(2, 6, { sentiment: 20 })],
			NOW,
			rule,
		);
		expect(s.weights.get(1)).toBe(1);
		expect(s.weights.get(2)).toBeCloseTo(0.5);
		// (80*1 + 20*0.5) / 1.5 = 60
		expect(s.results.sentiment.average).toBe(60);
		expect(s.results.sentiment.count).toBe(2);
	});

	test("採点時刻が評価時刻より後の採点は使わない", () => {
		const late = news(1, 1, { sentiment: 90 }, { scoredAt: NOW + 1 });
		const s = judgeAt([late], NOW, rule);
		expect(s.results.sentiment).toEqual({
			value: "0",
			average: null,
			count: 0,
		});
		expect(s.weights.size).toBe(0);
	});

	test("公開時刻が未来のニュースは取得時刻で扱う", () => {
		const n = news(1, 6, { sentiment: 90 }, { publishedAt: NOW + 5 * H });
		expect(newsTime(n)).toBe(NOW - 6 * H);
		expect(judgeAt([n], NOW, rule).weights.get(1)).toBeCloseTo(0.5);
	});

	test("半減期の4倍（短期は24時間）より前のニュースは使わない", () => {
		const s = judgeAt(
			[news(1, 24, { sentiment: 80 }), news(2, 23.9, { sentiment: -80 })],
			NOW,
			rule,
		);
		expect([...s.weights.keys()]).toEqual([2]);
		expect(s.results.sentiment.value).toBe("-2");
	});

	test("0 点の観点も平均に入れる", () => {
		const s = judgeAt(
			[news(1, 0, { risk: 80 }), news(2, 0, { sentiment: 40 })],
			NOW,
			rule,
		);
		expect(s.results.risk).toEqual({ value: "caution", average: 40, count: 2 });
		expect(s.results.sentiment).toEqual({ value: "+1", average: 20, count: 2 });
	});

	test("持続 none のニュースは使わず、対象が無ければ中立", () => {
		const s = judgeAt(
			[news(1, 0, { risk: 75 }, { duration: "none" })],
			NOW,
			rule,
		);
		expect(s.weights.size).toBe(0);
		expect(s.results.risk).toEqual({
			value: "normal",
			average: null,
			count: 0,
		});
	});

	test("半減期は持続ごと。長く続くニュースは半減期の4倍まで使う", () => {
		const list = [
			news(1, 0, { sentiment: 0 }),
			news(2, 24, { sentiment: 90 }, { duration: "medium" }),
			news(3, 72, { sentiment: -90 }, { duration: "long" }),
			news(4, 96, { sentiment: 90 }, { duration: "medium" }),
		];
		const s = judgeAt(list, NOW, rule);
		expect(s.weights.get(1)).toBe(1);
		expect(s.weights.get(2)).toBeCloseTo(0.5);
		expect(s.weights.get(3)).toBeCloseTo(0.5);
		expect(s.weights.has(4)).toBe(false);
		// (0*1 + 90*0.5 - 90*0.5) / 2 = 0
		expect(s.results.sentiment.average).toBe(0);
		expect(s.results.sentiment.count).toBe(3);
	});
});

test("平均点は整数に丸めてから判定する", () => {
	// (20*1 + 19*0.5) / 1.5 = 19.67 → 20 点で +1
	const s = judgeAt(
		[news(1, 0, { sentiment: 20 }), news(2, 6, { sentiment: 19 })],
		NOW,
		rule,
	);
	expect(s.results.sentiment).toEqual({ value: "+1", average: 20, count: 2 });
});

describe("classify のしきい値の境界", () => {
	test.each([
		[39.9, "normal"],
		[40, "caution"],
		[69.9, "caution"],
		[70, "crisis"],
	] as const)("リスク %p → %p", (avg, v) => {
		expect(classify("risk", avg, rule)).toBe(v);
	});
	test.each([
		[60, "+2"],
		[59.9, "+1"],
		[20, "+1"],
		[19.9, "0"],
		[-20, "0"],
		[-20.1, "-1"],
		[-60, "-1"],
		[-60.1, "-2"],
	] as const)("センチメント %p → %p", (avg, v) => {
		expect(classify("sentiment", avg, rule)).toBe(v);
	});
});

test("重み付き平均がしきい値ちょうどなら、評価時刻によらずその段になる", () => {
	const list = [
		news(1, 1.3, { risk: 70, sentiment: 20 }),
		news(2, 7.7, { risk: 70, sentiment: 20 }),
	];
	const times: number[] = [];
	for (let i = 0; i < 2000; i++) times.push(NOW + i * 37_003);
	for (const p of judgmentSeries(list, times, rule)) {
		expect(p.values).toEqual({ sentiment: "+1", risk: "crisis" });
		const r = judgeAt(list, p.time, rule).results;
		expect([r.sentiment.value, r.risk.value]).toEqual(["+1", "crisis"]);
	}
});

describe("judgmentSeries", () => {
	test("各時刻で judgeAt と同じ判定になる", () => {
		const list: ScoredNews[] = [];
		for (let i = 0; i < 200; i++) {
			const t = NOW - 48 * H + i * 17 * 60_000;
			list.push({
				id: i,
				publishedAt: t - (i % 3) * 10 * 60_000,
				fetchedAt: t,
				scoredAt: t + (i % 5) * 60_000,
				scores: {
					risk: (i * 53) % 101,
					sentiment: (i * 29) % 101,
				},
				duration: DURATIONS[i % 4] as Duration,
			});
		}
		const times: number[] = [];
		for (let t = NOW - 48 * H; t <= NOW + 300 * H; t += 7 * 60_000)
			times.push(t);
		const series = judgmentSeries(list, times, rule);
		for (const p of series) {
			const r = judgeAt(list, p.time, rule).results;
			expect(p.values).toEqual({
				sentiment: r.sentiment.value,
				risk: r.risk.value,
			});
		}
	});

	test("時刻が昇順でなければ例外", () => {
		expect(() => judgmentSeries([], [2, 1], rule)).toThrow(RangeError);
	});

	test("1年分の1分足でも数秒以内", () => {
		const start = 0;
		const list: ScoredNews[] = [];
		for (let i = 0; i < 365 * 100; i++) {
			const t = start + i * 864_000;
			list.push(
				news(
					i,
					0,
					{ sentiment: i % 101, risk: 50 },
					{
						publishedAt: t,
						fetchedAt: t,
						scoredAt: t + 60_000,
					},
				),
			);
		}
		const times: number[] = [];
		for (let t = start; t < start + 365 * 24 * H; t += 60_000) times.push(t);
		const begin = performance.now();
		const series = judgmentSeries(list, times, rule);
		expect(series.length).toBe(times.length);
		expect(performance.now() - begin).toBeLessThan(3000);
	});

	test("持続が混ざっても1か月分の1分足なら数秒以内", () => {
		const list: ScoredNews[] = [];
		for (let i = 0; i < 30 * 100; i++) {
			const t = i * 864_000;
			list.push(
				news(
					i,
					0,
					{ sentiment: i % 101, risk: 50 },
					{
						publishedAt: t,
						fetchedAt: t,
						scoredAt: t + 60_000,
						duration: i % 10 === 0 ? "long" : "short",
					},
				),
			);
		}
		const times: number[] = [];
		for (let t = 0; t < 30 * 24 * H; t += 60_000) times.push(t);
		const begin = performance.now();
		expect(judgmentSeries(list, times, rule).length).toBe(times.length);
		expect(performance.now() - begin).toBeLessThan(3000);
	});
});

describe("judgmentBands", () => {
	test("上の区間から、重ならず隙間の無い整数の区間で表す", () => {
		expect(judgmentBands("sentiment", rule)).toEqual([
			{ value: "+2", min: 60, max: 100, key: "plus2" },
			{ value: "+1", min: 20, max: 59, key: "plus1" },
			{ value: "0", min: -20, max: 19, key: "minus1" },
			{ value: "-1", min: -60, max: -21, key: "minus2" },
			{ value: "-2", min: -100, max: -61, key: null },
		]);
		expect(judgmentBands("risk", rule)).toEqual([
			{ value: "crisis", min: 70, max: 100, key: "crisis" },
			{ value: "caution", min: 40, max: 69, key: "caution" },
			{ value: "normal", min: 0, max: 39, key: null },
		]);
	});

	test("区間の端の点数は classify でもその区間になる", () => {
		for (const j of ["sentiment", "risk"] as const) {
			for (const b of judgmentBands(j, rule)) {
				expect(classify(j, b.min, rule)).toBe(b.value);
				expect(classify(j, b.max, rule)).toBe(b.value);
			}
		}
	});
});

describe("validateAggregationRule", () => {
	test("既定値は通る", () => {
		expect(validateAggregationRule(rule)).toEqual([]);
	});

	test("範囲外と並びの矛盾を指摘する", () => {
		const bad: AggregationRule = {
			halfLifeHours: { short: 0, medium: 6.5, long: 72 },
			thresholds: {
				risk: { caution: 70, crisis: 40 },
				sentiment: { plus2: 60, plus1: 60, minus1: 70, minus2: 70 },
			},
		};
		expect(validateAggregationRule(bad).map((e) => e.path)).toEqual([
			"halfLifeHours.short",
			"halfLifeHours.medium",
			"thresholds.risk.caution",
			"thresholds.sentiment.plus1",
			"thresholds.sentiment.minus1",
			"thresholds.sentiment.minus2",
		]);
	});

	test("しきい値が観点の点数の範囲の整数でなければ並びは見ない", () => {
		const bad = structuredClone(rule);
		bad.thresholds.risk.caution = -1;
		bad.thresholds.sentiment.minus2 = -101;
		expect(validateAggregationRule(bad).map((e) => e.path)).toEqual([
			"thresholds.sentiment.minus2",
			"thresholds.risk.caution",
		]);
	});

	test("センチメントは負のしきい値を受け付ける", () => {
		const r = structuredClone(rule);
		r.thresholds.sentiment = {
			plus2: 0,
			plus1: -10,
			minus1: -50,
			minus2: -100,
		};
		expect(validateAggregationRule(r)).toEqual([]);
	});
});

test("parseAggregationRule は形が違えば null", () => {
	expect(parseAggregationRule(JSON.parse(JSON.stringify(rule)))).toEqual(rule);
	expect(parseAggregationRule({ windowHours: 24 })).toBeNull();
});

test("parseAggregationRule は半減期が1つの古い形を短期として読む", () => {
	const old = {
		windowHours: 24,
		halfLifeHours: 8,
		thresholds: rule.thresholds,
	};
	expect(parseAggregationRule(old)).toEqual({
		...rule,
		halfLifeHours: { short: 8, medium: 24, long: 72 },
	});
	expect(
		parseAggregationRule({ ...old, halfLifeHours: 48 })?.halfLifeHours,
	).toEqual({ short: 48, medium: 48, long: 72 });
});

test("半減期は 短期 ≦ 中期 ≦ 長期 でなければ保存できない", () => {
	const r = structuredClone(rule);
	r.halfLifeHours = { short: 24, medium: 12, long: 6 };
	expect(validateAggregationRule(r).map((e) => e.path)).toEqual([
		"halfLifeHours.medium",
		"halfLifeHours.long",
	]);
	r.halfLifeHours = { short: 12, medium: 12, long: 12 };
	expect(validateAggregationRule(r)).toEqual([]);
});

test("同じ入力で2回実行すると結果が一致する", () => {
	const list = [
		news(1, 1, { sentiment: 70, risk: 30 }),
		news(2, 5, { sentiment: 10 }),
	];
	const times = [NOW - 2 * H, NOW - H, NOW];
	expect(judgmentSeries(list, times, rule)).toEqual(
		judgmentSeries(list, times, rule),
	);
	expect(judgeAt(list, NOW, rule)).toEqual(judgeAt(list, NOW, rule));
});
