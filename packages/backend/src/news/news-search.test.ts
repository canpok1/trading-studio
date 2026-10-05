import { expect, test } from "bun:test";
import type { Duration } from "@trading-studio/core";
import { createTestApp } from "../test-app";
import type { NewsSearchResult } from "./types";

const H = 3_600_000;

function setup() {
	const t = createTestApp();
	t.clock.now = 100 * H;
	const source = t.newsRepo.insertSource(
		{ name: "A", url: "https://a.example/feed", language: "ja" },
		0,
	);
	/** scores が null なら未採点のまま */
	const add = (
		title: string,
		hour: number,
		scores: { sentiment: number; risk: number } | null,
		opts: { summary?: string; comment?: string; duration?: Duration } = {},
	) => {
		t.newsRepo.saveFetched(
			source,
			[
				{
					title,
					url: `https://a.example/${title}`,
					summary: opts.summary ?? null,
					publishedAt: hour * H,
				},
			],
			hour * H,
		);
		const id = (
			t.newsRepo.listNews(100).find((n) => n.title === title) as { id: number }
		).id;
		if (scores) {
			t.scoreRepo.saveScore(
				id,
				{
					scores,
					duration: opts.duration ?? "short",
					comment: opts.comment ?? "",
				},
				{
					scoredAt: hour * H,
					criteriaVersion: 1,
					model: "m",
					appBuiltAt: null,
					attempts: 0,
				},
			);
		}
	};
	const search = async (query: string) => {
		const r = await t.app.request(`/api/news?${query}`);
		return { status: r.status, body: (await r.json()) as NewsSearchResult };
	};
	const titles = async (query: string) =>
		(await search(query)).body.news.map((n) => n.title);
	return { ...t, add, search, titles };
}

test("条件なしは新しい順で、件数は limit を超えた分も数える", async () => {
	const t = setup();
	t.add("a", 90, null);
	t.add("b", 91, { sentiment: 0, risk: 0 });
	t.add("c", 92, null);
	const r = await t.search("limit=2");
	expect(r.body.news.map((n) => n.title)).toEqual(["c", "b"]);
	expect(r.body.total).toBe(3);
});

test("期間は公開時刻が from 以上 to 未満", async () => {
	const t = setup();
	for (const h of [90, 91, 92, 93]) t.add(`n${h}`, h, null);
	expect(await t.titles(`from=${91 * H}&to=${93 * H}`)).toEqual(["n92", "n91"]);
	expect(await t.titles(`from=${92 * H}`)).toEqual(["n93", "n92"]);
	expect((await t.search("from=abc")).status).toBe(400);
});

test("影響の大きさは今の評価基準で測り、選んだどれかに当てはまるもの", async () => {
	const t = setup();
	// 既定の評価基準: やや強気 20 以上、やや弱気 −20 未満、警戒 40 以上
	t.add("bull", 90, { sentiment: 20, risk: 0 });
	t.add("flat", 91, { sentiment: 19, risk: 39 });
	t.add("bear", 92, { sentiment: -21, risk: 0 });
	t.add("risk", 93, { sentiment: 0, risk: 40 });
	t.add("unscored", 94, null);
	expect(await t.titles("impact=bull")).toEqual(["bull"]);
	expect(await t.titles("impact=bear")).toEqual(["bear"]);
	expect(await t.titles("impact=risk")).toEqual(["risk"]);
	expect(await t.titles("impact=bull,bear")).toEqual(["bear", "bull"]);
	expect((await t.search("impact=big")).status).toBe(400);
});

test("影響の大きい順は センチメントの絶対値とリスクの大きい方の順で、未採点は最後", async () => {
	const t = setup();
	t.add("s-80", 90, { sentiment: -80, risk: 10 });
	t.add("r50", 91, { sentiment: 10, risk: 50 });
	t.add("unscored", 92, null);
	t.add("none", 93, { sentiment: 0, risk: 0 }, { duration: "none" });
	expect(await t.titles("sort=impact")).toEqual([
		"s-80",
		"r50",
		"none",
		"unscored",
	]);
	expect((await t.search("sort=old")).status).toBe(400);
});

test("キーワードは語をすべて含むもの。見出し・概要・採点の理由から探し、% や _ は文字として扱う", async () => {
	const t = setup();
	t.add("Bitcoin ETF approved", 90, null);
	t.add("SEC", 91, null, { summary: "ETF の審査" });
	t.add("x", 92, { sentiment: 10, risk: 0 }, { comment: "ETF 承認で強気" });
	t.add("100% up", 93, null);
	t.add("100 up", 94, null);
	expect(await t.titles("q=etf")).toEqual(["x", "SEC", "Bitcoin ETF approved"]);
	expect(await t.titles(`q=${encodeURIComponent("ETF 強気")}`)).toEqual(["x"]);
	expect(await t.titles(`q=${encodeURIComponent("100%")}`)).toEqual([
		"100% up",
	]);
});
