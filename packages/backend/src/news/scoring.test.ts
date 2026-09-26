import { describe, expect, test } from "bun:test";
import { createTestDb } from "../db/test-db";
import { createTestApp } from "../test-app";
import type { ScoreModel } from "./gemini";
import { DEFAULT_SCORING_MODEL } from "./gemini";
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
				trend: 0,
				risk: null,
				sentiment: 100,
				comment: " 理由 ",
			}),
		).toEqual({
			scores: { trend: 0, risk: null, sentiment: 100 },
			comment: "理由",
		});
		for (const bad of [
			null,
			[],
			{ trend: 101, risk: null, sentiment: 1, comment: "c" },
			{ trend: 50.5, risk: null, sentiment: 1, comment: "c" },
			{ trend: "50", risk: null, sentiment: 1, comment: "c" },
			{ risk: null, sentiment: 1, comment: "c" },
			{ trend: 1, risk: null, sentiment: 1, comment: "" },
		]) {
			expect(typeof parseScoreResponse(bad)).toBe("string");
		}
	});
});

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
				trend: 60,
				risk: 30,
				sentiment: null,
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
		now: () => clock,
	});
	const service = createScoringService({
		repo,
		newsRepo,
		scorer,
		now: () => clock,
	});
	return {
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
	test("新着を1件ずつ採点し、採点時刻・版・モデルを記録する", async () => {
		const t = setup();
		const a = t.addNews("a");
		const b = t.addNews("b");
		await t.at(T0 + 1000);
		expect(t.repo.getScore(a)).toMatchObject({
			status: "done",
			scores: { trend: 60, risk: 30, sentiment: null },
			comment: "理由",
			scoredAt: T0 + 1000,
			criteriaVersion: 1,
			model: DEFAULT_SCORING_MODEL,
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
			{ trend: 101, risk: null, sentiment: 1, comment: "c" },
			new Error("Gemini API 503: overloaded"),
			"not json",
			{ trend: 1, risk: null, sentiment: 1, comment: "" },
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
			"trend が 0〜100 の整数か null でない",
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

	test("集計の期間より古い記事は採点しない", async () => {
		const t = setup();
		const old = t.addNews("old", T0 - 25 * H);
		const recent = t.addNews("recent", T0 - 23 * H);
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
			news: { id: latest, title: "latest" },
			scores: { trend: 60 },
		});
		expect(t.calls[0]?.prompt).toContain("試す基準");
		expect(t.repo.getScore(latest)).toBeNull();
		expect(await t.service.trial(" ")).toMatchObject({ ok: false });
	});

	test("試し採点はキーが無ければ理由を返す", async () => {
		const t = setup({ key: false });
		t.addNews("a");
		expect(await t.service.trial("基準")).toEqual({
			ok: false,
			message: "キーが無い",
		});
	});

	test("初版は1度だけ入れる", () => {
		const repo = new ScoreRepository(createTestDb());
		repo.seedCriteria("a", 0);
		repo.seedCriteria("b", 0);
		expect(repo.listCriteria().map((c) => c.text)).toEqual(["a"]);
		expect(repo.activeCriteriaVersion()).toBe(1);
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
