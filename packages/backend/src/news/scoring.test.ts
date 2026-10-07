import { describe, expect, test } from "bun:test";
import { DEFAULT_AGGREGATION_RULE } from "@trading-studio/core";
import { createTestDb } from "../db/test-db";
import { createTestApp } from "../test-app";
import type { ScoreModel } from "./gemini";
import { DEFAULT_SCORING_MODEL, geminiModel, NO_API_KEY } from "./gemini";
import { buildPrompt, DEFAULT_CRITERIA, parseScoreResponse } from "./prompt";
import { NewsRepository } from "./repository";
import { ScoreRepository } from "./score-repository";
import { createScorer, RETRY_DELAYS_MS } from "./scorer";
import { createScoringService } from "./scoring-service";

const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 26, 3);

describe("プロンプト", () => {
	test("ニュース → 採点の基準 → 依頼・出力形式の順に差し込む", () => {
		const p = buildPrompt(
			{
				sourceName: "A",
				title: "見出し {criteria}",
				summary: "概要",
				publishedAt: T0,
			},
			"基準",
		);
		expect(p.indexOf("<news>")).toBeLessThan(p.indexOf("<criteria>"));
		expect(p.indexOf("<criteria>")).toBeLessThan(p.indexOf("# 依頼"));
		expect(p).toContain("見出し: 見出し {criteria}");
		expect(p).toContain("概要: 概要");
		expect(p).toContain("公開時刻: 2026-09-26 12:00 JST");
		expect(p).toContain("<criteria>\n基準\n</criteria>");
	});

	test("概要が無ければ見出しだけ", () => {
		const p = buildPrompt(
			{ sourceName: "A", title: "t", summary: null, publishedAt: T0 },
			"基準",
		);
		expect(p).not.toContain("概要:");
	});

	test("応答の検証", () => {
		expect(
			parseScoreResponse({
				sentiment: 100,
				risk: 0,
				duration: "long",
				comment: " 理由 ",
			}),
		).toEqual({
			scores: { sentiment: 100, risk: 0 },
			duration: "long",
			comment: "理由",
		});
		for (const bad of [
			null,
			[],
			{ sentiment: 101, risk: 0, duration: "short", comment: "c" },
			{ sentiment: -101, risk: 0, duration: "short", comment: "c" },
			{ sentiment: 1, risk: -1, duration: "short", comment: "c" },
			{ sentiment: 1, risk: 101, duration: "short", comment: "c" },
			{ sentiment: 50.5, risk: 0, duration: "short", comment: "c" },
			{ sentiment: "50", risk: 0, duration: "short", comment: "c" },
			{ sentiment: null, risk: 0, duration: "short", comment: "c" },
			{ risk: 0, duration: "short", comment: "c" },
			{ sentiment: 1, duration: "short", comment: "c" },
			{ sentiment: 1, risk: 0, comment: "c" },
			{ sentiment: 1, risk: 0, duration: "forever", comment: "c" },
			{ sentiment: 1, risk: 0, duration: "short", comment: "" },
		]) {
			expect(typeof parseScoreResponse(bad)).toBe("string");
		}
	});

	test("持続 none の記事は点数を 0 にそろえる", () => {
		expect(
			parseScoreResponse({
				sentiment: 30,
				risk: 20,
				duration: "none",
				comment: "関係ない",
			}),
		).toMatchObject({ scores: { sentiment: 0, risk: 0 }, duration: "none" });
	});
});

const BUILT_AT = Date.UTC(2026, 8, 27, 0, 10);

function setup(opts: { key?: boolean } = {}) {
	let clock = T0;
	const db = createTestDb();
	const newsRepo = new NewsRepository(db);
	const repo = new ScoreRepository(db);
	repo.seedCriteria(DEFAULT_CRITERIA, T0);
	const source = newsRepo.insertSource(
		{ name: "A", url: "https://a.example/feed", language: "ja" },
		T0,
	);
	const calls: { model: string; prompt: string }[] = [];
	const replies: unknown[] = [];
	const model: ScoreModel = {
		unavailable: () => (opts.key === false ? "キーが無い" : null),
		async generate(m, prompt) {
			calls.push({ model: m, prompt });
			const r = replies.shift() ?? {
				sentiment: 60,
				risk: 30,
				duration: "short",
				comment: "理由",
			};
			if (r instanceof Error) throw r;
			return r;
		},
	};
	const scorer = createScorer({
		repo,
		model,
		rule: () => repo.aggregationRule(),
		appBuiltAt: BUILT_AT,
		now: () => clock,
		minIntervalMs: 0,
	});
	const service = createScoringService({
		repo,
		newsRepo,
		scorer,
		now: () => clock,
	});
	return {
		db,
		repo,
		newsRepo,
		scorer,
		service,
		calls,
		replies,
		addNews(title: string, publishedAt = clock) {
			newsRepo.saveFetched(
				source,
				[
					{
						title,
						url: `https://a.example/${title}`,
						summary: null,
						publishedAt,
					},
				],
				clock,
			);
			return (
				newsRepo.listNews(100).find((n) => n.title === title) as {
					id: number;
				}
			).id;
		},
		async at(time: number) {
			clock = time;
			scorer.tick();
			await scorer.idle();
		},
	};
}

describe("採点", () => {
	test("新着を1件ずつ採点し、採点時刻・版・モデル・アプリのバージョンを記録する", async () => {
		const t = setup();
		const a = t.addNews("a");
		const b = t.addNews("b");
		await t.at(T0 + 1000);
		expect(t.repo.getScore(a)).toMatchObject({
			status: "done",
			scores: { sentiment: 60, risk: 30 },
			comment: "理由",
			scoredAt: T0 + 1000,
			criteriaVersion: 1,
			model: DEFAULT_SCORING_MODEL,
			appBuiltAt: BUILT_AT,
		});
		expect(t.repo.getScore(b)).toBeNull();
		await t.at(T0 + 2000);
		expect(t.repo.getScore(b)?.status).toBe("done");
		await t.at(T0 + 3000);
		expect(t.calls).toHaveLength(2);
		expect(t.repo.scoredNews(0, T0 + H).map((n) => n.id)).toEqual([a, b]);
		expect(t.service.status()).toMatchObject({ state: "running", pending: 0 });
	});

	test("形式違いの応答は失敗し、3回まで間隔を延ばして再試行し、それでも失敗なら止まる", async () => {
		const t = setup();
		const a = t.addNews("a");
		t.replies.push(
			{ sentiment: 101, risk: 0, duration: "short", comment: "c" },
			new Error("Gemini API 503: overloaded"),
			"not json",
			{ sentiment: 1, risk: 0, duration: "short", comment: "" },
		);
		let time = T0;
		await t.at(time);
		expect(t.repo.getScore(a)).toMatchObject({
			status: "retry",
			nextAttemptAt: time + (RETRY_DELAYS_MS[0] as number),
		});
		expect(t.service.status()).toMatchObject({
			state: "stopped",
			stoppedSince: T0,
		});
		expect(t.service.status().error).toContain(
			"sentiment が -100〜100 の整数でない",
		);
		// 再試行の時刻の前は採点しない
		await t.at(time + 1000);
		expect(t.calls).toHaveLength(1);
		for (const d of RETRY_DELAYS_MS) {
			time += d;
			await t.at(time);
		}
		expect(t.calls).toHaveLength(4);
		expect(t.repo.getScore(a)).toMatchObject({
			status: "failed",
			scores: null,
			nextAttemptAt: null,
			error: "応答の形が違う: comment が空",
		});
		expect(t.repo.scoredNews(0, time + H)).toEqual([]);

		// 手動の再試行で採点し直せる
		expect(t.service.retry(a)).toBe(true);
		await t.at(time + 1000);
		expect(t.repo.getScore(a)?.status).toBe("done");
		expect(t.service.status().state).toBe("running");
		expect(t.service.retry(a)).toBe(false);
	});

	test("版・モデルを切り替えても採点済みは変わらず、次から新しい版・モデルで採点する", async () => {
		const t = setup();
		const a = t.addNews("a");
		await t.at(T0);
		const r = t.service.addCriteria("新しい基準", "試す");
		if (!r.ok) throw new Error();
		expect(t.service.setActiveCriteria(r.version.version)).toBe(true);
		expect(t.service.setModel("gemini-3.8-flash")).toBe(true);
		expect(t.service.setModel("unknown")).toBe(false);
		const before = t.repo.getScore(a);
		const b = t.addNews("b");
		await t.at(T0 + 1000);
		await t.at(T0 + 2000);
		expect(t.repo.getScore(a)).toEqual(before);
		expect(t.repo.getScore(b)).toMatchObject({
			criteriaVersion: 2,
			model: "gemini-3.8-flash",
		});
		expect(t.calls[1]?.prompt).toContain("新しい基準");
		expect(t.calls[1]?.model).toBe("gemini-3.8-flash");
	});

	test("API キーが無いと採点は止まり、理由が状態に出る", async () => {
		const t = setup({ key: false });
		const a = t.addNews("a");
		await t.at(T0);
		await t.at(T0 + 1000);
		expect(t.calls).toHaveLength(0);
		expect(t.repo.getScore(a)).toBeNull();
		expect(t.service.status()).toMatchObject({
			state: "stopped",
			error: "キーが無い",
			stoppedSince: T0,
			pending: 1,
		});
	});

	test("採点そのものが進めないときは止まっていると状態に出す", async () => {
		const t = setup();
		t.addNews("a");
		t.repo.setActiveCriteria(999);
		await t.at(T0);
		expect(t.calls).toHaveLength(0);
		expect(t.service.status()).toMatchObject({
			state: "stopped",
			stoppedSince: T0,
		});
	});

	test("保存された集計ルールが読めなければ既定値を使う", () => {
		const t = setup();
		t.db.$client.run(
			"insert into settings (key, value) values ('aggregation_rule', '{')",
		);
		expect(t.repo.aggregationRule()).toEqual(DEFAULT_AGGREGATION_RULE);
	});

	test("集計に使う一番長い長さより古い記事は採点しない", async () => {
		const t = setup();
		// 一番長い長期の半減期（72時間）の4倍
		const old = t.addNews("old", T0 - 289 * H);
		const recent = t.addNews("recent", T0 - 287 * H);
		await t.at(T0);
		expect(t.repo.getScore(old)?.status).toBe("skipped");
		expect(t.repo.getScore(recent)?.status).toBe("done");
		expect(t.calls).toHaveLength(1);
	});

	test("試し採点は最新のニュースを採点し、保存しない", async () => {
		const t = setup();
		t.addNews("old", T0 - H);
		const latest = t.addNews("latest", T0);
		const r = await t.service.trial("試す基準");
		expect(r).toMatchObject({
			ok: true,
			items: [
				{
					news: { id: latest, title: "latest", stored: null },
					result: { ok: true, scores: { sentiment: 60 } },
				},
			],
		});
		expect(t.calls[0]?.prompt).toContain("試す基準");
		expect(t.repo.getScore(latest)).toBeNull();
		expect(await t.service.trial(" ")).toMatchObject({ ok: false });
	});

	test("試し採点は選んだ記事を採点し、保存済みの採点と並べる", async () => {
		const t = setup();
		const a = t.addNews("a", T0 - H);
		const b = t.addNews("b", T0);
		await t.at(T0);
		await t.at(T0);
		t.replies.push({
			sentiment: -10,
			risk: 5,
			duration: "short",
			comment: "案",
		});
		const r = await t.service.trial("案の基準", [a, 999]);
		expect(r).toMatchObject({
			ok: true,
			items: [
				{
					news: {
						id: a,
						stored: { scores: { sentiment: 60 }, criteriaVersion: 1 },
					},
					result: { ok: true, scores: { sentiment: -10 }, comment: "案" },
				},
			],
		});
		expect(t.repo.getScore(a)?.scores?.sentiment).toBe(60);
		expect(await t.service.trial("x", [999])).toEqual({
			ok: false,
			message: "ニュースが見つからない",
		});
		expect(await t.service.trial("x", [a, b, a, b, a, b])).toMatchObject({
			ok: false,
		});
	});

	test("試し採点はキーが無ければ理由を返す", async () => {
		const t = setup({ key: false });
		t.addNews("a");
		expect(await t.service.trial("基準")).toMatchObject({
			ok: true,
			items: [{ result: { ok: false, message: "キーが無い" } }],
		});
	});

	test("試し採点も常駐の採点と合わせて問い合わせの間を空ける", async () => {
		let clock = T0;
		const db = createTestDb();
		const repo = new ScoreRepository(db);
		repo.seedCriteria(DEFAULT_CRITERIA, T0);
		const waits: number[] = [];
		const scorer = createScorer({
			repo,
			model: {
				unavailable: () => null,
				generate: async () => ({
					sentiment: 0,
					risk: 0,
					comment: "c",
				}),
			},
			rule: () => repo.aggregationRule(),
			now: () => clock,
			minIntervalMs: 5_000,
			sleep: async (ms) => {
				waits.push(ms);
				clock += ms;
			},
		});
		const news = {
			sourceName: "A",
			title: "t",
			summary: null,
			publishedAt: T0,
		};
		await scorer.trial(news, "基準");
		clock += 1_000;
		await scorer.trial(news, "基準");
		expect(waits).toEqual([4_000]);
	});

	test("初版は1度だけ入れる", () => {
		const repo = new ScoreRepository(createTestDb());
		repo.seedCriteria("a", 0);
		repo.seedCriteria("b", 0);
		expect(repo.listCriteria().map((c) => c.text)).toEqual(["a"]);
		expect(repo.activeCriteriaVersion()).toBe(1);
	});
});

describe("API キー", () => {
	test("保存したキーで採点し、削除すると止まる。キーそのものは返さない", async () => {
		const t = setup({ key: false });
		const repo = t.repo;
		expect(t.service.apiKey()).toEqual({ configured: false, savedAt: null });
		expect(t.service.setApiKey(" ")).toEqual({
			ok: false,
			message: "API キーを入れる",
		});
		expect(t.service.setApiKey("a b")).toMatchObject({ ok: false });
		expect(t.service.setApiKey("x".repeat(201))).toMatchObject({ ok: false });
		expect(t.service.setApiKey(" k1 ")).toEqual({ ok: true });
		expect(repo.apiKey()).toBe("k1");
		expect(t.service.apiKey()).toEqual({ configured: true, savedAt: T0 });
		t.service.deleteApiKey();
		expect(t.service.apiKey()).toEqual({ configured: false, savedAt: null });
		expect(repo.apiKey()).toBeNull();
	});

	test("キーを保存すると、前のキーでの失敗を消して採点し直す", async () => {
		const t = setup();
		const a = t.addNews("a");
		t.replies.push(
			...RETRY_DELAYS_MS.map(() => new Error("403")),
			new Error("403"),
		);
		await t.at(T0);
		let time = T0;
		for (const d of RETRY_DELAYS_MS) {
			time += d;
			await t.at(time);
		}
		expect(t.repo.getScore(a)?.status).toBe("failed");
		expect(t.service.status().state).toBe("stopped");
		t.service.setApiKey("new");
		expect(t.service.status().state).toBe("running");
		await t.at(time + 1);
		expect(t.repo.getScore(a)?.status).toBe("done");
	});

	test("Gemini のモデルは保存されたキーを問い合わせのたびに読む", async () => {
		let key: string | null = null;
		const model = geminiModel(() => key);
		expect(model.unavailable()).toBe(NO_API_KEY);
		await expect(model.generate("m", "p", {})).rejects.toThrow(NO_API_KEY);
		key = "k";
		expect(model.unavailable()).toBeNull();
	});

	test("API は保存・上書き・削除でき、キーを返さない", async () => {
		const { app } = createTestApp();
		const put = (key: unknown) =>
			app.request("/api/scoring/api-key", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ key }),
			});
		expect(await (await app.request("/api/scoring/api-key")).json()).toEqual({
			configured: false,
			savedAt: null,
		});
		expect((await put("")).status).toBe(400);
		expect((await put(1)).status).toBe(400);
		const saved = await put("secret-1");
		expect(saved.status).toBe(200);
		const body = await saved.text();
		expect(body).not.toContain("secret-1");
		expect(JSON.parse(body)).toMatchObject({ configured: true });
		expect(await (await put("secret-2")).text()).not.toContain("secret-2");
		const got = await (await app.request("/api/scoring/api-key")).text();
		expect(got).not.toContain("secret");
		const deleted = await app.request("/api/scoring/api-key", {
			method: "DELETE",
		});
		expect(await deleted.json()).toEqual({ configured: false, savedAt: null });
	});
});

describe("採点の API", () => {
	test("採点の基準の版とモデル", async () => {
		const { app } = createTestApp();
		const json = (method: string, body: unknown) => ({
			method,
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		expect(
			await (await app.request("/api/scoring/criteria")).json(),
		).toMatchObject({
			activeVersion: 1,
			versions: [{ version: 1, note: "初版" }],
		});
		const created = await app.request(
			"/api/scoring/criteria",
			json("POST", { text: "基準2", note: "メモ" }),
		);
		expect(created.status).toBe(201);
		expect(
			(await app.request("/api/scoring/criteria", json("POST", { text: " " })))
				.status,
		).toBe(400);
		const active = await app.request(
			"/api/scoring/criteria/active",
			json("PUT", { version: 2 }),
		);
		expect(await active.json()).toMatchObject({ activeVersion: 2 });
		expect(
			(
				await app.request(
					"/api/scoring/criteria/active",
					json("PUT", { version: 9 }),
				)
			).status,
		).toBe(404);

		expect(
			await (await app.request("/api/scoring/model")).json(),
		).toMatchObject({
			current: DEFAULT_SCORING_MODEL,
		});
		expect(
			(await app.request("/api/scoring/model", json("PUT", { model: "x" })))
				.status,
		).toBe(400);
		expect(
			await (
				await app.request(
					"/api/scoring/model",
					json("PUT", { model: "gemini-3.8-flash" }),
				)
			).json(),
		).toMatchObject({ current: "gemini-3.8-flash" });
	});

	test("ニュースの一覧に採点の結果が付き、失敗したものだけ再試行できる", async () => {
		const t = createTestApp();
		const source = t.newsRepo.insertSource(
			{ name: "A", url: "https://a.example/feed", language: "ja" },
			0,
		);
		t.newsRepo.saveFetched(
			source,
			[
				{
					title: "a",
					url: "https://a.example/a",
					summary: null,
					publishedAt: t.clock.now,
				},
			],
			t.clock.now,
		);
		t.scorer.tick();
		await t.scorer.idle();
		const { news } = (await (await t.app.request("/api/news")).json()) as {
			news: { id: number; score: unknown }[];
		};
		expect(news[0]?.score).toMatchObject({
			status: "done",
			criteriaVersion: 1,
		});
		const id = news[0]?.id;
		expect(
			(await t.app.request(`/api/scoring/news/${id}/retry`, { method: "POST" }))
				.status,
		).toBe(409);
		t.scoreRepo.saveFailure(id as number, "x", 4, null);
		expect(
			(await t.app.request(`/api/scoring/news/${id}/retry`, { method: "POST" }))
				.status,
		).toBe(200);
	});
});

test("問い合わせの間を最短の間隔だけ空ける", async () => {
	let clock = T0;
	const db = createTestDb();
	const newsRepo = new NewsRepository(db);
	const repo = new ScoreRepository(db);
	repo.seedCriteria(DEFAULT_CRITERIA, T0);
	const source = newsRepo.insertSource(
		{ name: "A", url: "https://a.example/feed", language: "ja" },
		T0,
	);
	newsRepo.saveFetched(
		source,
		["a", "b"].map((t) => ({
			title: t,
			url: `https://a.example/${t}`,
			summary: null,
			publishedAt: T0,
		})),
		T0,
	);
	let calls = 0;
	const scorer = createScorer({
		repo,
		model: {
			unavailable: () => null,
			async generate() {
				calls++;
				return { sentiment: 1, risk: 1, duration: "short", comment: "c" };
			},
		},
		rule: () => repo.aggregationRule(),
		now: () => clock,
		minIntervalMs: 5000,
	});
	for (const t of [0, 1000, 4999, 5000]) {
		clock = T0 + t;
		scorer.tick();
		await scorer.idle();
	}
	expect(calls).toBe(2);
});

describe("版を指定した採点し直し", () => {
	/** 運用で採点済みのニュースを作る。採点時刻は T0 + i 秒 */
	async function scored(t: ReturnType<typeof setup>, n: number) {
		const ids = Array.from({ length: n }, (_, i) => t.addNews(`n${i}`));
		for (let i = 1; i <= n; i++) await t.at(T0 + i * 1000);
		return ids as [number, ...number[]];
	}

	test("新着が無いときに頼まれた版で採点し、運用の採点は変えず、採点時刻は運用のものを使う", async () => {
		const t = setup();
		const [a, b] = (await scored(t, 2)) as [number, number];
		const v2 = t.service.addCriteria("基準2", "改善");
		if (!v2.ok) throw new Error();
		const version = v2.version.version;
		// 期間の頭は集計の期間（24時間）だけ前まで含める
		const from = T0 + 24 * H;
		const req = t.service.requestRescore(from, from + H, version);
		expect(req).toMatchObject({
			ok: true,
			coverage: { total: 2, done: 0, pending: 2, failed: 0 },
		});
		// 新着を先に採点する
		const c = t.addNews("c");
		t.replies.push({
			sentiment: 10,
			risk: 0,
			duration: "short",
			comment: "新着",
		});
		await t.at(T0 + 10_000);
		expect(t.repo.getScore(c)?.status).toBe("done");
		t.replies.push(
			{ sentiment: -80, risk: 5, duration: "short", comment: "v2" },
			{ sentiment: -40, risk: 0, duration: "short", comment: "v2" },
		);
		await t.at(T0 + 11_000);
		await t.at(T0 + 12_000);
		expect(t.calls.at(-1)?.prompt).toContain("基準2");
		expect(t.repo.getScore(a)).toMatchObject({
			criteriaVersion: 1,
			scores: { sentiment: 60, risk: 30 },
		});
		// 頼んだ後に採点した新着は、頼み直すまで入らない
		expect(t.service.rescoreCoverage(from, from + H, version)).toMatchObject({
			ok: true,
			coverage: { total: 3, done: 2, pending: 0 },
		});
		expect(t.repo.scoredNews(0, T0 + 5000, version)).toEqual([
			expect.objectContaining({
				id: a,
				scoredAt: T0 + 1000,
				scores: { sentiment: -80, risk: 5 },
			}),
			expect.objectContaining({ id: b, scoredAt: T0 + 2000 }),
		]);
		// 運用で v2 で採点した記事は、採点し直さずにその採点を使う
		t.service.setActiveCriteria(version);
		const d = t.addNews("d");
		await t.at(T0 + 13_000);
		expect(t.repo.scoredNews(T0 + 13_000, T0 + 14_000, version)).toEqual([
			expect.objectContaining({ id: d }),
		]);
		expect(
			t.service.rescoreCoverage(
				T0 + 13_000 + 288 * H,
				T0 + 14_000 + 288 * H,
				version,
			),
		).toMatchObject({ coverage: { total: 1, done: 1 } });
		// 運用どおりなら、それぞれの記事を運用で採点した点数
		expect(
			t.repo.scoredNews(0, T0 + 5000).map((n) => n.scores.sentiment),
		).toEqual([60, 60]);
	});

	test("失敗は再試行し、止まったものは頼み直すと採点し直す", async () => {
		const t = setup();
		const [a] = await scored(t, 1);
		const v2 = t.service.addCriteria("基準2", "改善");
		if (!v2.ok) throw new Error();
		const version = v2.version.version;
		const from = T0 + 24 * H;
		t.service.requestRescore(from, from + H, version);
		t.replies.push(
			...RETRY_DELAYS_MS.map(() => new Error("503")),
			new Error("503"),
		);
		let time = T0 + 10_000;
		await t.at(time);
		for (const d of RETRY_DELAYS_MS) {
			time += d;
			await t.at(time);
		}
		expect(t.service.rescoreCoverage(from, from + H, version)).toMatchObject({
			coverage: { total: 1, done: 0, pending: 0, failed: 1 },
		});
		expect(t.service.requestRescore(from, from + H, version)).toMatchObject({
			coverage: { pending: 1, failed: 0 },
		});
		await t.at(time + 1000);
		expect(t.repo.scoredNews(0, T0 + 5000, version).map((n) => n.id)).toEqual([
			a,
		]);
	});

	test("期間の形が違うか版が無ければ理由を返す", () => {
		const t = setup();
		expect(t.service.requestRescore(10, 5, 1)).toMatchObject({
			ok: false,
			status: 400,
		});
		expect(t.service.rescoreCoverage(0, 5, 99)).toMatchObject({
			ok: false,
			status: 404,
		});
	});
});

describe("運用の採点を置き換える採点し直し", () => {
	/** 運用で v1 で採点済みのニュースを作り、v2 を使用中にする。採点時刻は T0 + i 秒 */
	async function scoredThenV2(t: ReturnType<typeof setup>, n: number) {
		const ids = Array.from({ length: n }, (_, i) => t.addNews(`n${i}`));
		for (let i = 1; i <= n; i++) await t.at(T0 + i * 1000);
		const v2 = t.service.addCriteria("基準2", "改善");
		if (!v2.ok) throw new Error();
		t.service.setActiveCriteria(v2.version.version);
		return ids as [number, ...number[]];
	}
	test("使用中の版で採点し直して運用の採点を置き換え、使い始める時刻は変えず、元の採点は版の採点として残す", async () => {
		const t = setup();
		const [a] = await scoredThenV2(t, 1);
		expect(t.service.rescoreLive(a)).toEqual({
			ok: true,
			version: 2,
			requested: true,
		});
		expect(t.service.status().rescorePending).toBe(1);
		expect(t.newsRepo.newsByIds([a])[0]?.rescore).toEqual({
			version: 2,
			status: "pending",
			error: null,
		});
		t.replies.push({
			sentiment: -70,
			risk: 10,
			duration: "short",
			comment: "v2 の理由",
		});
		await t.at(T0 + 10_000);
		expect(t.calls.at(-1)?.prompt).toContain("基準2");
		const item = t.newsRepo.newsByIds([a])[0];
		expect(item?.rescore).toBeNull();
		expect(item?.score).toMatchObject({
			scores: { sentiment: -70, risk: 10 },
			comment: "v2 の理由",
			criteriaVersion: 2,
			scoredAt: T0 + 1000,
			rescoredAt: T0 + 10_000,
		});
		expect(t.service.status().rescorePending).toBe(0);
		// 運用どおりは置き換えた点数、v1 を指定すると元の点数。どちらも使い始める時刻は運用の採点時刻
		expect(t.repo.scoredNews(0, T0 + 5000)).toEqual([
			expect.objectContaining({
				scoredAt: T0 + 1000,
				scores: { sentiment: -70, risk: 10 },
			}),
		]);
		expect(t.repo.scoredNews(0, T0 + 5000, 1)).toEqual([
			expect.objectContaining({
				scoredAt: T0 + 1000,
				scores: { sentiment: 60, risk: 30 },
			}),
		]);
		// 使用中の版で採点済みなら頼まない
		expect(t.service.rescoreLive(a)).toMatchObject({ requested: false });
	});

	test("その版の採点が既にあれば、問い合わせずにすぐ置き換える", async () => {
		const t = setup();
		const [a] = await scoredThenV2(t, 1);
		const from = T0 + 24 * H;
		t.service.requestRescore(from, from + H, 2);
		t.replies.push({
			sentiment: -20,
			risk: 0,
			duration: "short",
			comment: "v2",
		});
		await t.at(T0 + 10_000);
		expect(t.repo.getScore(a)?.criteriaVersion).toBe(1);
		const calls = t.calls.length;
		expect(t.service.rescoreLive(a)).toMatchObject({
			requested: true,
		});
		expect(t.calls).toHaveLength(calls);
		expect(t.repo.getScore(a)).toMatchObject({
			criteriaVersion: 2,
			scores: { sentiment: -20, risk: 0 },
			rescoredAt: T0 + 10_000,
		});
	});

	test("バックテスト用に待っている採点し直しは、順番を変えずに置き換える印を付ける", async () => {
		const t = setup();
		const [a] = await scoredThenV2(t, 1);
		const from = T0 + 24 * H;
		t.service.requestRescore(from, from + H, 2);
		t.service.rescoreLive(a);
		await t.at(T0 + 10_000);
		expect(t.repo.getScore(a)?.criteriaVersion).toBe(2);
	});

	test("後から別の版で頼んだ置き換えを優先し、前の頼みが後で終わっても戻さない", async () => {
		const t = setup();
		const [a] = await scoredThenV2(t, 1);
		t.service.rescoreLive(a);
		t.replies.push(new Error("503"));
		await t.at(T0 + 10_000);
		// v2 が再試行を待っている間に v3 へ切り替えて頼み直す
		const v3 = t.service.addCriteria("基準3", "改善");
		if (!v3.ok) throw new Error();
		t.service.setActiveCriteria(v3.version.version);
		t.service.rescoreLive(a);
		t.replies.push({
			sentiment: 30,
			risk: 0,
			duration: "short",
			comment: "v3",
		});
		await t.at(T0 + 11_000);
		expect(t.repo.getScore(a)?.criteriaVersion).toBe(3);
		// v2 の再試行が後で成功しても、運用の採点は v3 のまま
		t.replies.push({
			sentiment: -90,
			risk: 0,
			duration: "short",
			comment: "v2",
		});
		await t.at(T0 + 10_000 + RETRY_DELAYS_MS[0]);
		expect(t.calls.at(-1)?.prompt).toContain("基準2");
		expect(t.newsRepo.newsByIds([a])[0]).toMatchObject({
			rescore: null,
			score: { criteriaVersion: 3, scores: { sentiment: 30 } },
		});
		expect(t.service.status().rescorePending).toBe(0);
	});

	test("失敗して止まると理由を出し、頼み直すと採点し直す", async () => {
		const t = setup();
		const [a] = await scoredThenV2(t, 1);
		t.service.rescoreLive(a);
		t.replies.push(
			...RETRY_DELAYS_MS.map(() => new Error("503")),
			new Error("503"),
		);
		let time = T0 + 10_000;
		await t.at(time);
		for (const d of RETRY_DELAYS_MS) {
			time += d;
			await t.at(time);
		}
		expect(t.newsRepo.newsByIds([a])[0]?.rescore).toEqual({
			version: 2,
			status: "failed",
			error: "503",
		});
		expect(t.repo.getScore(a)?.criteriaVersion).toBe(1);
		expect(t.service.rescoreLive(a)).toMatchObject({
			requested: true,
		});
		expect(t.newsRepo.newsByIds([a])[0]?.rescore?.status).toBe("pending");
		await t.at(time + 1000);
		expect(t.newsRepo.newsByIds([a])[0]).toMatchObject({
			rescore: null,
			score: { criteriaVersion: 2 },
		});
	});

	test("運用で採点済みでないものは頼まない", async () => {
		const t = setup();
		await scoredThenV2(t, 1);
		// 採点に失敗して止まっている記事
		const d = t.addNews("d");
		t.replies.push(
			...RETRY_DELAYS_MS.map(() => new Error("503")),
			new Error("503"),
		);
		let time = T0 + 11_000;
		await t.at(time);
		for (const delay of RETRY_DELAYS_MS) {
			time += delay;
			await t.at(time);
		}
		expect(t.repo.getScore(d)?.status).toBe("failed");
		expect(t.service.rescoreLive(d)).toMatchObject({ requested: false });
		expect(t.newsRepo.newsByIds([d])[0]?.rescore).toBeNull();
	});

	test("使用中の版が無ければ理由を返す", () => {
		const t = setup();
		t.repo.setActiveCriteria(999);
		expect(t.service.rescoreLive(1)).toMatchObject({
			ok: false,
			status: 409,
		});
	});

	test("API", async () => {
		const { app } = createTestApp();
		const post = (path: string) =>
			app.request(`/api/scoring/news/${path}`, { method: "POST" });
		expect((await post("1/rescore")).status).toBe(409);
		// まとめて採点し直す API は無い
		expect((await post("rescore?q=abc")).status).toBe(404);
	});
});
