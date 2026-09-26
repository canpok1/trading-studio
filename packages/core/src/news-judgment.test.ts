import { describe, expect, test } from "bun:test";
import type { AggregationRule, ScoredNews, Scores } from "./news-judgment";
import {
	classify,
	DEFAULT_AGGREGATION_RULE,
	judgeAt,
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
		scores: { trend: null, risk: null, sentiment: null, ...scores },
		...over,
	};
}

describe("judgeAt", () => {
	test("半減期ちょうど前のニュースの重みは今の半分", () => {
		const s = judgeAt(
			[news(1, 0, { trend: 80 }), news(2, 6, { trend: 20 })],
			NOW,
			rule,
		);
		expect(s.weights.get(1)).toBe(1);
		expect(s.weights.get(2)).toBeCloseTo(0.5);
		// (80*1 + 20*0.5) / 1.5 = 60
		expect(s.results.trend.average).toBe(60);
		expect(s.results.trend.count).toBe(2);
	});

	test("採点時刻が評価時刻より後の採点は使わない", () => {
		const late = news(1, 1, { trend: 90 }, { scoredAt: NOW + 1 });
		const s = judgeAt([late], NOW, rule);
		expect(s.results.trend).toEqual({
			value: "range",
			average: null,
			count: 0,
		});
		expect(s.weights.size).toBe(0);
	});

	test("公開時刻が未来のニュースは取得時刻で扱う", () => {
		const n = news(1, 6, { trend: 90 }, { publishedAt: NOW + 5 * H });
		expect(newsTime(n)).toBe(NOW - 6 * H);
		expect(judgeAt([n], NOW, rule).weights.get(1)).toBeCloseTo(0.5);
	});

	test("期間（24時間）より前のニュースは使わない", () => {
		const s = judgeAt(
			[news(1, 24, { trend: 90 }), news(2, 23.9, { trend: 10 })],
			NOW,
			rule,
		);
		expect([...s.weights.keys()]).toEqual([2]);
		expect(s.results.trend.value).toBe("down");
	});

	test("null の観点は平均に入れず、対象が無い観点は中立", () => {
		const s = judgeAt([news(1, 0, { risk: 75 })], NOW, rule);
		expect(s.results.risk).toEqual({ value: "crisis", average: 75, count: 1 });
		expect(s.results.trend).toEqual({
			value: "range",
			average: null,
			count: 0,
		});
		expect(s.results.sentiment).toEqual({
			value: "0",
			average: null,
			count: 0,
		});
	});
});

test("平均点は整数に丸めてから判定する", () => {
	// (60*1 + 59*0.5) / 1.5 = 59.67 → 60 点で上昇
	const s = judgeAt(
		[news(1, 0, { trend: 60 }), news(2, 6, { trend: 59 })],
		NOW,
		rule,
	);
	expect(s.results.trend).toEqual({ value: "up", average: 60, count: 2 });
});

describe("classify のしきい値の境界", () => {
	test.each([
		[60, "up"],
		[59.9, "range"],
		[40.1, "range"],
		[40, "down"],
	] as const)("トレンド %p → %p", (avg, v) => {
		expect(classify("trend", avg, rule)).toBe(v);
	});
	test.each([
		[39.9, "normal"],
		[40, "caution"],
		[69.9, "caution"],
		[70, "crisis"],
	] as const)("リスク %p → %p", (avg, v) => {
		expect(classify("risk", avg, rule)).toBe(v);
	});
	test.each([
		[80, "+2"],
		[79.9, "+1"],
		[60, "+1"],
		[59.9, "0"],
		[40, "0"],
		[39.9, "-1"],
		[20, "-1"],
		[19.9, "-2"],
	] as const)("センチメント %p → %p", (avg, v) => {
		expect(classify("sentiment", avg, rule)).toBe(v);
	});
});

test("重み付き平均がしきい値ちょうどなら、評価時刻によらずその段になる", () => {
	const list = [
		news(1, 1.3, { trend: 60, risk: 70, sentiment: 40 }),
		news(2, 7.7, { trend: 60, risk: 70, sentiment: 40 }),
	];
	const times: number[] = [];
	for (let i = 0; i < 2000; i++) times.push(NOW + i * 37_003);
	for (const p of judgmentSeries(list, times, rule)) {
		expect(p.values).toEqual({ trend: "up", risk: "crisis", sentiment: "0" });
		const r = judgeAt(list, p.time, rule).results;
		expect([r.trend.value, r.risk.value, r.sentiment.value]).toEqual([
			"up",
			"crisis",
			"0",
		]);
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
					trend: i % 4 === 0 ? null : (i * 37) % 101,
					risk: (i * 53) % 101,
					sentiment: i % 7 === 0 ? null : (i * 29) % 101,
				},
			});
		}
		const times: number[] = [];
		for (let t = NOW - 48 * H; t <= NOW + 30 * H; t += 7 * 60_000)
			times.push(t);
		const series = judgmentSeries(list, times, rule);
		for (const p of series) {
			const r = judgeAt(list, p.time, rule).results;
			expect(p.values).toEqual({
				trend: r.trend.value,
				risk: r.risk.value,
				sentiment: r.sentiment.value,
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
					{ trend: i % 101, risk: 50, sentiment: 60 },
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
});

describe("validateAggregationRule", () => {
	test("既定値は通る", () => {
		expect(validateAggregationRule(rule)).toEqual([]);
	});

	test("範囲外と並びの矛盾を指摘する", () => {
		const bad: AggregationRule = {
			windowHours: 0,
			halfLifeHours: 6.5,
			thresholds: {
				trend: { up: 40, down: 40 },
				risk: { caution: 70, crisis: 40 },
				sentiment: { plus2: 60, plus1: 60, minus1: 70, minus2: 70 },
			},
		};
		expect(validateAggregationRule(bad).map((e) => e.path)).toEqual([
			"windowHours",
			"halfLifeHours",
			"thresholds.trend.down",
			"thresholds.risk.caution",
			"thresholds.sentiment.plus1",
			"thresholds.sentiment.minus1",
			"thresholds.sentiment.minus2",
		]);
	});

	test("しきい値が 0〜100 の整数でなければ並びは見ない", () => {
		const bad = structuredClone(rule);
		bad.thresholds.trend.up = 101;
		expect(validateAggregationRule(bad).map((e) => e.path)).toEqual([
			"thresholds.trend.up",
		]);
	});
});

test("parseAggregationRule は形が違えば null", () => {
	expect(parseAggregationRule(JSON.parse(JSON.stringify(rule)))).toEqual(rule);
	expect(parseAggregationRule({ windowHours: 24 })).toBeNull();
});

test("同じ入力で2回実行すると結果が一致する", () => {
	const list = [
		news(1, 1, { trend: 70, risk: 30 }),
		news(2, 5, { sentiment: 10 }),
	];
	const times = [NOW - 2 * H, NOW - H, NOW];
	expect(judgmentSeries(list, times, rule)).toEqual(
		judgmentSeries(list, times, rule),
	);
	expect(judgeAt(list, NOW, rule)).toEqual(judgeAt(list, NOW, rule));
});
