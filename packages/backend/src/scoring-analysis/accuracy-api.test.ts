import { describe, expect, test } from "bun:test";
import type { AccuracySettings, ArticleAccuracyReport } from "../index";
import { createTestApp } from "../test-app";
import { DEFAULT_ACCURACY_SETTINGS } from "./types";

const H = 3_600_000;
const START = Date.UTC(2026, 6, 31, 15);

/** 1時間ごとに 1% ずつ上がる価格と、採点済みの記事3件（採点は記事ごとに1時間ずれる） */
async function scored() {
	const t = createTestApp();
	const rows = Array.from({ length: 5 * 24 }, (_, i) => {
		const close = 10_000_000 + i * 100_000;
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
	const ids = t.db.$client
		.query<{ id: number }, []>("select id from news order by id")
		.all()
		.map((r) => r.id);
	return { t, ids };
}

const get = async (t: ReturnType<typeof createTestApp>, ids: number[]) => {
	const res = await t.app.request(`/api/scoring/accuracy?ids=${ids.join(",")}`);
	expect(res.status).toBe(200);
	return (await res.json()) as ArticleAccuracyReport;
};

describe("GET /api/scoring/accuracy", () => {
	test("測る長さがたった記事は精度を、たっていない記事は測定中を返す", async () => {
		const { t, ids } = await scored();
		const r1 = await get(t, ids);
		expect(r1.horizon).toBe("24h");
		expect(r1.items.map((x) => x.status)).toEqual([
			"measuring",
			"measuring",
			"measuring",
		]);

		t.clock.now = START + 4 * 24 * H;
		const r2 = await get(t, ids);
		expect(r2.items).toHaveLength(3);
		for (const x of r2.items) {
			expect(x.status).toBe("ok");
			if (x.status !== "ok") continue;
			expect(x.sentiment).toBeGreaterThanOrEqual(1);
			expect(x.sentiment).toBeLessThanOrEqual(5);
			expect(x.risk).toBeGreaterThanOrEqual(1);
			expect(x.risk).toBeLessThanOrEqual(5);
		}
	});

	test("持続なしの記事と、無い ID は返さない", async () => {
		const { t, ids } = await scored();
		t.db.$client
			.query("update news_scores set duration = 'none' where news_id = ?")
			.run(ids[0] as number);
		t.clock.now = START + 4 * 24 * H;
		const r = await get(t, [...ids, 99_999]);
		expect(r.items.map((x) => x.id)).toEqual(ids.slice(1));
	});

	test("ID の形が違えば 400", async () => {
		const t = createTestApp();
		const res = await t.app.request("/api/scoring/accuracy?ids=1,a");
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

	test("保存した長さで測る", async () => {
		const { t, ids } = await scored();
		const before = await t.app.request("/api/scoring/accuracy/settings");
		expect(await before.json()).toEqual(DEFAULT_ACCURACY_SETTINGS);
		const saved: AccuracySettings = {
			...DEFAULT_ACCURACY_SETTINGS,
			horizon: "4h",
			riskBands: {
				"4h": { slight: 1, rough: 1.5, heavy: 2, wild: 3 },
				"24h": { slight: 1, rough: 2, heavy: 3, wild: 5 },
			},
		};
		expect((await put(t, saved)).status).toBe(200);
		const now = await t.app.request("/api/scoring/accuracy/settings");
		expect(await now.json()).toEqual(saved);
		t.clock.now = START + 30 * H;
		const r = await get(t, ids);
		expect(r.horizon).toBe("4h");
		expect(r.items.every((x) => x.status === "ok")).toBe(true);
	});

	test("リスクの境目が2つだった頃の保存値は、リスクの境目だけ既定にする", async () => {
		const t = createTestApp();
		t.db.$client.run(
			"insert into settings (key, value) values ('accuracy_settings', ?)",
			[
				JSON.stringify({
					days: 7,
					horizon: "4h",
					minSamples: 5,
					sentimentBands: DEFAULT_ACCURACY_SETTINGS.sentimentBands,
					riskBands: {
						"4h": { rough: 1, wild: 1.5 },
						"24h": { rough: 2, wild: 3 },
					},
				}),
			],
		);
		const res = await t.app.request("/api/scoring/accuracy/settings");
		expect(await res.json()).toEqual({
			...DEFAULT_ACCURACY_SETTINGS,
			horizon: "4h",
		});
	});

	test("範囲外の値は 400 で、保存しない", async () => {
		const t = createTestApp();
		expect(
			(await put(t, { ...DEFAULT_ACCURACY_SETTINGS, horizon: "1h" })).status,
		).toBe(400);
		const bad = await put(t, {
			...DEFAULT_ACCURACY_SETTINGS,
			riskBands: {
				...DEFAULT_ACCURACY_SETTINGS.riskBands,
				"24h": { slight: 1, rough: 3, heavy: 2, wild: 5 },
			},
		});
		expect(bad.status).toBe(400);
		expect(await bad.json()).toMatchObject({ field: "riskBands" });
		const now = await t.app.request("/api/scoring/accuracy/settings");
		expect(await now.json()).toEqual(DEFAULT_ACCURACY_SETTINGS);
	});
});
