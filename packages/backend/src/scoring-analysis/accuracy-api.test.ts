import { describe, expect, test } from "bun:test";
import type { AccuracyReport, AccuracySettings } from "../index";
import { createTestApp } from "../test-app";
import { DEFAULT_ACCURACY_SETTINGS } from "./types";

const H = 3_600_000;
const START = Date.UTC(2026, 6, 31, 15);

async function scored() {
	const t = createTestApp();
	const rows = Array.from({ length: 5 * 24 }, (_, i) => {
		const close = 10_000_000 + i * 10_000;
		return {
			time: START + i * H,
			open: close,
			high: close,
			low: close,
			close,
			volume: 1_000_000,
		};
	});
	const importId = t.marketDataRepo.createImport("1h", "a.csv", 0);
	t.marketDataRepo.insertImported("1h", rows, importId);
	const source = t.newsRepo.insertSource(
		{ name: "A", url: "https://a.example/feed", language: "ja" },
		0,
	);
	t.clock.now = START + 24 * H;
	t.newsRepo.saveFetched(
		source,
		["一", "二", "三"].map((title, i) => ({
			title,
			url: `https://a.example/${i}`,
			summary: null,
			publishedAt: START + (20 + i) * H,
		})),
		t.clock.now,
	);
	for (let i = 0; i < 3; i++) {
		t.scorer.tick();
		await t.scorer.idle();
	}
	t.clock.now = START + 4 * 24 * H;
	return t;
}

describe("GET /api/scoring/accuracy", () => {
	test("版ごとの精度と、ほかの版から採点し直した記事との比較を返す", async () => {
		const t = await scored();
		const [first] = t.db.$client
			.query<{ id: number }, []>("select id from news order by id limit 1")
			.all();
		t.db.$client
			.query(
				`insert into news_rescores (news_id, criteria_version, status, sentiment, risk, comment, scored_at, requested_at)
				 values (?, 2, 'done', 30, 15, '旧', 0, 0)`,
			)
			.run(first?.id as number);

		const res = await t.app.request("/api/scoring/accuracy?horizon=4h");
		expect(res.status).toBe(200);
		const r = (await res.json()) as AccuracyReport;
		expect(r).toMatchObject({
			horizon: "4h",
			days: 30,
			activeVersion: 1,
			priceTimeframe: "1h",
		});
		expect(r.influence.judgedHours).toBeGreaterThan(0);
		expect(r.versions.map((v) => [v.version, v.articles])).toEqual([
			[2, 1],
			[1, 3],
		]);
		expect(r.comparisons).toMatchObject([
			{ version: 2, common: 1, active: { version: 1, articles: 1 } },
		]);
	});

	test("測る長さが 4h・24h 以外なら 400", async () => {
		const t = createTestApp();
		const res = await t.app.request("/api/scoring/accuracy?horizon=1h");
		expect(res.status).toBe(400);
	});
});

describe("/api/scoring/accuracy/settings", () => {
	const put = (t: ReturnType<typeof createTestApp>, body: unknown) =>
		t.app.request("/api/scoring/accuracy/settings", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});

	test("保存した期間・長さ・件数で集計する。長さを省くと設定の長さ", async () => {
		const t = await scored();
		const before = await t.app.request("/api/scoring/accuracy/settings");
		expect(await before.json()).toEqual(DEFAULT_ACCURACY_SETTINGS);
		const saved: AccuracySettings = {
			...DEFAULT_ACCURACY_SETTINGS,
			days: 7,
			horizon: "4h",
			minSamples: 5,
			riskBands: {
				"4h": { rough: 1, wild: 1.5 },
				"24h": { rough: 2, wild: 3 },
			},
		};
		expect((await put(t, saved)).status).toBe(200);
		const res = await t.app.request("/api/scoring/accuracy");
		const r = (await res.json()) as AccuracyReport;
		expect(r).toMatchObject({
			days: 7,
			horizon: "4h",
			minSamples: 5,
			riskBands: { rough: 1, wild: 1.5 },
			sentimentBands: { small: 0.2, large: 0.7 },
		});
		expect(r.to - r.from).toBe(7 * 24 * H);
	});

	test("範囲外の値は 400 で、保存しない", async () => {
		const t = createTestApp();
		const bad = await put(t, { ...DEFAULT_ACCURACY_SETTINGS, days: 93 });
		expect(bad.status).toBe(400);
		expect(await bad.json()).toMatchObject({ field: "days" });
		expect(
			(await put(t, { ...DEFAULT_ACCURACY_SETTINGS, horizon: "1h" })).status,
		).toBe(400);
		expect(
			(await put(t, { ...DEFAULT_ACCURACY_SETTINGS, minSamples: 0 })).status,
		).toBe(400);
		const now = await t.app.request("/api/scoring/accuracy/settings");
		expect(await now.json()).toMatchObject({ days: 30 });
	});
});
