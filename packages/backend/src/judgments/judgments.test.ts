import { expect, test } from "bun:test";
import { DEFAULT_AGGREGATION_RULE } from "@trading-studio/core";
import { createTestApp } from "../test-app";
import type { CurrentJudgment, JudgmentSeries } from "./types";

const H = 3_600_000;

function setup() {
	const t = createTestApp();
	t.clock.now = 100 * H;
	const source = t.newsRepo.insertSource(
		{ name: "A", url: "https://a.example/feed", language: "ja" },
		0,
	);
	const add = (title: string, hoursAgo: number, sentiment: number) => {
		const at = t.clock.now - hoursAgo * H;
		t.newsRepo.saveFetched(
			source,
			[
				{
					title,
					url: `https://a.example/${title}`,
					summary: null,
					publishedAt: at,
				},
			],
			at,
		);
		const id = (
			t.newsRepo.listNews(100).find((n) => n.title === title) as { id: number }
		).id;
		t.scoreRepo.saveScore(
			id,
			{ scores: { sentiment, risk: 0 }, duration: "short", comment: "c" },
			{
				scoredAt: at,
				criteriaVersion: 1,
				model: "m",
				appBuiltAt: null,
				attempts: 0,
			},
		);
		return id;
	};
	return { ...t, add };
}

async function sentimentNow(app: ReturnType<typeof createTestApp>["app"]) {
	return (
		(await (
			await app.request("/api/judgments/current")
		).json()) as CurrentJudgment
	).results.sentiment.value;
}

const json = (method: string, body: unknown) => ({
	method,
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

test("今の判定と重み", async () => {
	const t = setup();
	const a = t.add("a", 0, 60);
	const b = t.add("b", 6, -60);
	t.add("old", 30, -100);
	const r = (await (
		await t.app.request("/api/judgments/current")
	).json()) as CurrentJudgment;
	expect(r).toMatchObject({
		time: 100 * H,
		results: {
			sentiment: { value: "+1", average: 20, count: 2 },
			risk: { value: "calm", average: 0, count: 2 },
		},
		firstScoredAt: 70 * H,
	});
	expect(r.weights[a]).toBe(1);
	expect(r.weights[b]).toBeCloseTo(0.5);
	// 内訳は重み 0% の記事（old）を数えない
	expect(r.breakdown.sentiment.map((row) => [row.value, row.count])).toEqual([
		["+2", 1],
		["+1", 0],
		["0", 0],
		["-1", 1],
		["-2", 0],
	]);
	expect(r.breakdown.sentiment[0]?.share).toBeCloseTo(2 / 3);
});

test("集計ルールの保存で判定が変わる。試算は保存しない", async () => {
	const t = setup();
	t.add("a", 0, 20);
	const rule = structuredClone(DEFAULT_AGGREGATION_RULE);
	rule.thresholds.sentiment.plus1 = 30;
	const preview = await t.app.request(
		"/api/judgments/preview",
		json("POST", { rule }),
	);
	expect(await preview.json()).toMatchObject({
		results: { sentiment: { value: "0" } },
	});
	expect(await sentimentNow(t.app)).toBe("+1");
	const saved = await t.app.request(
		"/api/judgments/rule",
		json("PUT", { rule }),
	);
	expect(saved.status).toBe(200);
	expect(await sentimentNow(t.app)).toBe("0");

	rule.thresholds.sentiment.minus1 = 80;
	const bad = await t.app.request("/api/judgments/rule", json("PUT", { rule }));
	expect(bad.status).toBe(400);
	expect(await bad.json()).toMatchObject({
		errors: [{ path: "thresholds.sentiment.minus1" }],
	});
	expect(
		(await t.app.request("/api/judgments/rule", json("PUT", { rule: 1 })))
			.status,
	).toBe(400);
});

test("足ごとの判定は足の終わりの時刻で出し、採点の記録が始まる前は null", async () => {
	const t = setup();
	t.add("a", 10, 60);
	t.add("b", 2, -100);
	const r = (await (
		await t.app.request(
			`/api/judgments/series?from=${88 * H}&to=${102 * H}&timeframe=1h`,
		)
	).json()) as JudgmentSeries;
	expect(r.firstScoredAt).toBe(90 * H);
	expect(r.values.sentiment).toEqual([
		null,
		"+2",
		"+2",
		"+2",
		"+2",
		"+2",
		"+2",
		"+2",
		"+2",
		"-1",
		"-1",
		"-1",
		// 今より後に終わる足は今の判定
		"-1",
		"-1",
	]);
	expect(r.values.risk[0]).toBeNull();
	expect(r.values.risk[1]).toBe("calm");
});

test("足の粒度や期間が不正なら 400", async () => {
	const t = setup();
	for (const q of [
		"from=0&to=10&timeframe=2m",
		"from=10&to=0&timeframe=1m",
		`from=0&to=${400_000 * 60_000}&timeframe=1m`,
	]) {
		expect((await t.app.request(`/api/judgments/series?${q}`)).status).toBe(
			400,
		);
	}
});

test("時刻を指定するとその時点の判定。先の時刻は今", async () => {
	const t = setup();
	t.add("a", 10, 60);
	t.add("b", 0, -100);
	const at = async (time: number) =>
		(await (
			await t.app.request(`/api/judgments/current?at=${time}`)
		).json()) as CurrentJudgment;
	const past = await at(95 * H);
	expect(past.time).toBe(95 * H);
	expect(past.results.sentiment).toMatchObject({ average: 60, count: 1 });
	expect((await at(200 * H)).time).toBe(100 * H);
	expect((await t.app.request("/api/judgments/current?at=x")).status).toBe(400);
});
