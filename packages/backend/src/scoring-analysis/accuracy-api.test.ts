import { describe, expect, test } from "bun:test";
import type {
	AccuracySettings,
	AccuracySummary,
	ArticleAccuracyReport,
} from "../index";
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

describe("GET /api/scoring/accuracy/summary", () => {
	const summary = async (t: ReturnType<typeof createTestApp>, at?: number) => {
		const res = await t.app.request(
			`/api/scoring/accuracy/summary${at === undefined ? "" : `?at=${at}`}`,
		);
		expect(res.status).toBe(200);
		return (await res.json()) as AccuracySummary;
	};

	test("精度を出せた記事を観点ごとに 5〜1 で数え、測定中の記事は数えない", async () => {
		const { t } = await scored();
		const r1 = await summary(t);
		expect(r1.results.sentiment as unknown).toEqual({
			count: 0,
			average: null,
			rows: [5, 4, 3, 2, 1].map((precision) => ({
				precision,
				count: 0,
				levels: ["+2", "+1", "0", "-1", "-2"].map((value) => ({
					value,
					count: 0,
				})),
			})),
		});

		t.clock.now = START + 4 * 24 * H;
		const r2 = await summary(t);
		expect(r2.horizon).toBe("24h");
		expect(r2.periodDays).toBe(30);
		expect(r2.time).toBe(t.clock.now);
		for (const j of ["sentiment", "risk"] as const) {
			const r = r2.results[j];
			expect(r.count).toBe(3);
			expect(r.rows.map((x) => x.precision)).toEqual([5, 4, 3, 2, 1]);
			expect(r.rows.reduce((a, x) => a + x.count, 0)).toBe(3);
			const sum = r.rows.reduce((a, x) => a + x.precision * x.count, 0);
			expect(r.average).toBe(Math.round((sum / 3) * 10) / 10);
		}
	});

	test("精度ごとの件数を、記事の点数の段階で分ける", async () => {
		const { t } = await scored();
		// 価格は 24時間で 20% 余り上がるので、かなり強気は精度 5、平常は精度 1
		t.db.$client.run("update news_scores set sentiment = 80, risk = 0");
		t.clock.now = START + 4 * 24 * H;
		const r = await summary(t);
		const s5 = r.results.sentiment.rows[0];
		expect(s5?.count).toBe(3);
		expect(s5?.levels.find((x) => x.value === "+2")?.count).toBe(3);
		const r1 = r.results.risk.rows[4];
		expect(r1?.precision).toBe(1);
		expect(r1?.levels.map((x) => [x.value, x.count])).toEqual([
			["calm", 3],
			["mild", 0],
			["alert", 0],
			["severe", 0],
			["crisis", 0],
		]);
	});

	test("持続なしの記事は数えない", async () => {
		const { t, ids } = await scored();
		t.db.$client
			.query("update news_scores set duration = 'none' where news_id = ?")
			.run(ids[0] as number);
		t.clock.now = START + 4 * 24 * H;
		expect((await summary(t)).results.risk.count).toBe(2);
	});

	test("時点から設定の期間より前に採点した記事は数えず、すべてなら数える", async () => {
		const { t } = await scored();
		t.clock.now = START + 4 * 24 * H;
		// 採点は START + 24h ごろ。7日の期間なら 9日後の時点からは外れる
		await t.app.request("/api/scoring/accuracy/settings", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...DEFAULT_ACCURACY_SETTINGS, periodDays: 7 }),
		});
		expect((await summary(t, START + 9 * 24 * H)).results.risk.count).toBe(0);
		expect((await summary(t, START + 3 * 24 * H)).results.risk.count).toBe(3);
		// 時点より後に採点した記事も数えない
		expect((await summary(t, START + 12 * H)).results.risk.count).toBe(0);

		await t.app.request("/api/scoring/accuracy/settings", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...DEFAULT_ACCURACY_SETTINGS, periodDays: null }),
		});
		const all = await summary(t, START + 400 * 24 * H);
		expect(all.periodDays).toBeNull();
		expect(all.results.risk.count).toBe(3);
	});

	test("時点の形が違えば 400、期間が選択肢に無ければ 400", async () => {
		const t = createTestApp();
		expect(
			(await t.app.request("/api/scoring/accuracy/summary?at=x")).status,
		).toBe(400);
		const bad = await t.app.request("/api/scoring/accuracy/settings", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...DEFAULT_ACCURACY_SETTINGS, periodDays: 14 }),
		});
		expect(bad.status).toBe(400);
		expect(await bad.json()).toMatchObject({ field: "periodDays" });
	});
});
