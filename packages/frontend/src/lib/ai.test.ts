import { expect, test } from "bun:test";
import type {
	NewsCollectorStatus,
	NewsItem,
	NewsSource,
	ScorerStatus,
} from "@trading-studio/backend";
import { aiTroubles, newsState } from "./ai";

const source = (over: Partial<NewsSource>): NewsSource => ({
	id: 1,
	name: "A",
	url: "https://a.example",
	language: "ja",
	enabled: true,
	createdAt: 0,
	lastSuccessAt: 0,
	lastError: null,
	errorSince: null,
	...over,
});
const collector = (
	over: Partial<NewsCollectorStatus>,
): NewsCollectorStatus => ({
	state: "running",
	error: null,
	stoppedSince: null,
	intervalMinutes: 15,
	lastRunAt: 0,
	nextRunAt: 0,
	sources: [],
	...over,
});
const scorer = (over: Partial<ScorerStatus>): ScorerStatus => ({
	state: "running",
	error: null,
	stoppedSince: null,
	model: "m",
	activeCriteriaVersion: 1,
	pending: 0,
	...over,
});

test("止まっている間だけ知らせる", () => {
	expect(aiTroubles(collector({}), scorer({}))).toEqual([]);
	const t = aiTroubles(
		collector({
			state: "stopped",
			error: "すべての取得元で取得に失敗している",
			stoppedSince: 5,
			sources: [source({ lastError: "HTTP 503", errorSince: 5 })],
		}),
		scorer({
			state: "stopped",
			error: "キーが無い",
			stoppedSince: 7,
			pending: 3,
		}),
	);
	expect(t.map((x) => [x.title, x.since])).toEqual([
		["ニュースの収集が止まっている", 5],
		["ニュースの採点が止まっている", 7],
	]);
	expect(t[0]?.lines).toContain("A: HTTP 503");
	expect(t[1]?.lines[1]).toContain("3 件");
});

test("一部の取得元だけ失敗しているときも知らせる", () => {
	const t = aiTroubles(
		collector({
			sources: [
				source({}),
				source({ id: 2, name: "B", lastError: "HTTP 404", errorSince: 0 }),
				source({ id: 3, name: "C", enabled: false, lastError: "x" }),
			],
		}),
		scorer({}),
	);
	expect(t).toHaveLength(1);
	expect(t[0]?.title).toBe("一部の取得元から取得できていない");
	expect(t[0]?.lines).toHaveLength(1);
});

test("ニュースの採点の状態", () => {
	const n = { score: null } as NewsItem;
	expect(newsState(n, true)).toEqual({ kind: "waiting", stopped: true });
	const score = (status: "done" | "retry" | "failed" | "skipped") =>
		({
			score: {
				status,
				scores: null,
				comment: null,
				scoredAt: null,
				criteriaVersion: null,
				model: null,
				error: "e",
				nextAttemptAt: 9,
			},
		}) as NewsItem;
	expect(newsState(score("retry"), false)).toEqual({
		kind: "retry",
		error: "e",
		nextAttemptAt: 9,
	});
	expect(newsState(score("failed"), false)).toEqual({
		kind: "failed",
		error: "e",
	});
	expect(newsState(score("skipped"), false)).toEqual({ kind: "skipped" });
});
