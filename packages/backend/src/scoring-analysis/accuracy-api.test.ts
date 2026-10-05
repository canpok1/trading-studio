import { describe, expect, test } from "bun:test";
import type { AccuracyReport } from "../index";
import { createTestApp } from "../test-app";

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
	test("版ごとの当たり具合と、ほかの版から採点し直した記事との比較を返す", async () => {
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
