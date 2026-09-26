import { describe, expect, test } from "bun:test";
import { createTestDb } from "../db/test-db";
import { createTestApp } from "../test-app";
import { createNewsCollector } from "./collector";
import { NewsRepository } from "./repository";
import { parseFeed, SUMMARY_MAX } from "./rss";
import { createNewsService } from "./service";

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 26, 3);

function rss(items: { title: string; link: string; pubDate?: string }[]) {
	return `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items
		.map(
			(i) =>
				`<item><title>${i.title}</title><link>${i.link}</link><description>概要</description>${i.pubDate ? `<pubDate>${i.pubDate}</pubDate>` : ""}</item>`,
		)
		.join("")}</channel></rss>`;
}

describe("parseFeed", () => {
	test("RSS 2.0: CDATA・HTML・実体参照を外し、公開時刻を読む", () => {
		const items = parseFeed(
			`<rss version="2.0"><channel><item><title><![CDATA[BTC &amp; 円]]></title><link>https://a.example/1</link><description>&lt;p&gt;上昇 &amp;amp; <b>急騰</b>&lt;/p&gt;</description><pubDate>Sat, 26 Sep 2026 03:00:00 GMT</pubDate></item></channel></rss>`,
		);
		expect(items).toEqual([
			{
				title: "BTC & 円",
				url: "https://a.example/1",
				summary: "上昇 & 急騰",
				publishedAt: T0,
			},
		]);
	});

	test("見出しの山括弧はタグとして消さない", () => {
		const items = parseFeed(
			`<rss version="2.0"><channel><item><title>S&amp;P 500 &lt;速報&gt; 急落</title><link>https://a.example/1</link></item></channel></rss>`,
		);
		expect(items[0]?.title).toBe("S&P 500 <速報> 急落");
	});

	test("Atom: link の href と summary・published を読む", () => {
		const items = parseFeed(
			`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A</title><link rel="self" href="https://a.example/self"/><link href="https://a.example/a"/><summary>s</summary><published>2026-09-26T12:00:00+09:00</published></entry></feed>`,
		);
		expect(items).toEqual([
			{ title: "A", url: "https://a.example/a", summary: "s", publishedAt: T0 },
		]);
	});

	test("RSS 1.0 の dc:date、概要なし、公開時刻なし", () => {
		const items = parseFeed(
			`<rdf:RDF><item><title>A</title><link>https://a.example/a</link><dc:date>2026-09-26T03:00:00Z</dc:date></item><item><title>B</title><link>https://a.example/b</link></item></rdf:RDF>`,
		);
		expect(items).toEqual([
			{
				title: "A",
				url: "https://a.example/a",
				summary: null,
				publishedAt: T0,
			},
			{
				title: "B",
				url: "https://a.example/b",
				summary: null,
				publishedAt: null,
			},
		]);
	});

	test("長い概要は切る。見出しか URL が無い記事は捨てる", () => {
		const long = "あ".repeat(SUMMARY_MAX + 10);
		const items = parseFeed(
			`<rss><channel><item><title>A</title><link>https://a.example/a</link><description>${long}</description></item><item><title></title><link>https://a.example/b</link></item><item><title>C</title><link>not-a-url</link></item></channel></rss>`,
		);
		expect(items).toHaveLength(1);
		expect(items[0]?.summary).toBe(`${"あ".repeat(SUMMARY_MAX)}…`);
	});

	test("RSS でなければ例外", () => {
		expect(() => parseFeed("<html><body>404</body></html>")).toThrow();
	});
});

function setup() {
	let clock = T0;
	const repo = new NewsRepository(createTestDb());
	const feeds = new Map<string, string | Error>();
	const fetched: string[] = [];
	const collector = createNewsCollector({
		repo,
		now: () => clock,
		fetchFeed: async (url) => {
			fetched.push(url);
			const f = feeds.get(url);
			if (f === undefined) throw new Error("HTTP 404");
			if (f instanceof Error) throw f;
			return f;
		},
	});
	const service = createNewsService({ repo, collector, now: () => clock });
	const a = service.addSource({
		name: "A",
		url: "https://a.example/feed",
		language: "ja",
	});
	const b = service.addSource({
		name: "B",
		url: "https://b.example/feed",
		language: "en",
	});
	if (!a.ok || !b.ok) throw new Error("setup");
	return {
		repo,
		service,
		collector,
		feeds,
		fetched,
		a: a.source,
		b: b.source,
		/** 時刻を進めて tick し、始まった収集の終わりを待つ */
		async at(time: number) {
			clock = time;
			collector.tick();
			await collector.idle();
		},
	};
}

describe("ニュース収集", () => {
	test("間隔ごとに新着だけが保存され、同じ URL は二重に保存されない", async () => {
		const t = setup();
		t.feeds.set(
			t.a.url,
			rss([
				{
					title: "a1",
					link: "https://x.example/1",
					pubDate: "Sat, 26 Sep 2026 02:00:00 GMT",
				},
			]),
		);
		// 別の取得元に同じ URL の記事がある
		t.feeds.set(
			t.b.url,
			rss([
				{ title: "b1", link: "https://x.example/1" },
				{ title: "b2", link: "https://x.example/2" },
			]),
		);
		await t.at(T0);
		expect(t.service.listNews(10).map((n) => n.title)).toEqual(["b2", "a1"]);
		const a1 = t.service.listNews(10).find((n) => n.title === "a1");
		expect(a1).toMatchObject({
			sourceName: "A",
			language: "ja",
			summary: "概要",
			publishedAt: T0 - 60 * MIN,
			fetchedAt: T0,
		});
		// 公開時刻が無い記事は取得時刻
		expect(
			t.service.listNews(10).find((n) => n.title === "b2")?.publishedAt,
		).toBe(T0);

		t.feeds.set(
			t.a.url,
			rss([
				{ title: "a1", link: "https://x.example/1" },
				{ title: "a3", link: "https://x.example/3" },
			]),
		);
		await t.at(T0 + 14 * MIN);
		expect(t.service.listNews(10)).toHaveLength(2);
		await t.at(T0 + 15 * MIN);
		expect(
			t.service
				.listNews(10)
				.map((n) => n.title)
				.sort(),
		).toEqual(["a1", "a3", "b2"]);
		expect(t.service.status()).toMatchObject({
			state: "running",
			lastRunAt: T0 + 15 * MIN,
			nextRunAt: T0 + 30 * MIN,
		});
	});

	test("無効にした取得元は次の収集から取らない。間隔の変更は次の収集から反映する", async () => {
		const t = setup();
		t.feeds.set(t.a.url, rss([]));
		t.feeds.set(t.b.url, rss([]));
		await t.at(T0);
		expect(t.fetched).toEqual([t.a.url, t.b.url]);
		expect(t.service.updateSource(t.b.id, { enabled: false }).ok).toBe(true);
		expect(t.service.setIntervalMinutes(5)).toEqual({ ok: true });
		expect(t.service.status().nextRunAt).toBe(T0 + 5 * MIN);
		await t.at(T0 + 5 * MIN);
		expect(t.fetched).toEqual([t.a.url, t.b.url, t.a.url]);
	});

	test("取得元が失敗すると状態に理由が出て、直ると消える", async () => {
		const t = setup();
		t.feeds.set(t.a.url, rss([]));
		t.feeds.set(t.b.url, new Error("HTTP 503"));
		await t.at(T0);
		let s = t.service.status();
		expect(s.state).toBe("running");
		expect(s.sources.find((x) => x.id === t.b.id)).toMatchObject({
			lastError: "取得できない: HTTP 503",
			errorSince: T0,
			lastSuccessAt: null,
		});

		t.feeds.set(t.a.url, "<html></html>");
		await t.at(T0 + 15 * MIN);
		s = t.service.status();
		expect(s).toMatchObject({
			state: "stopped",
			error: "すべての取得元で取得に失敗している",
			stoppedSince: T0,
		});
		expect(s.sources.find((x) => x.id === t.a.id)?.lastError).toContain(
			"RSS / Atom として読めない",
		);

		t.feeds.set(t.a.url, rss([]));
		t.feeds.set(t.b.url, rss([]));
		await t.at(T0 + 30 * MIN);
		s = t.service.status();
		expect(s.state).toBe("running");
		expect(
			s.sources.every((x) => x.lastError === null && x.errorSince === null),
		).toBe(true);
		expect(s.sources.every((x) => x.lastSuccessAt === T0 + 30 * MIN)).toBe(
			true,
		);
	});

	test("有効な取得元が無ければ停止中", () => {
		const t = setup();
		t.service.updateSource(t.a.id, { enabled: false });
		t.service.removeSource(t.b.id);
		expect(t.service.status()).toMatchObject({
			state: "stopped",
			error: "有効な取得元が無い",
		});
	});

	test("既定の取得元は1度だけ入れる（消した取得元を戻さない）", () => {
		const repo = new NewsRepository(createTestDb());
		const defaults = [
			{ name: "X", url: "https://x.example/feed", language: "ja" as const },
		];
		repo.seedSources(defaults, T0);
		expect(repo.listSources()).toHaveLength(1);
		repo.removeSource((repo.listSources()[0] as { id: number }).id);
		repo.seedSources(defaults, T0);
		expect(repo.listSources()).toHaveLength(0);
	});
});

describe("ニュースの API", () => {
	test("取得元の追加・変更・削除と入力検証", async () => {
		const { app } = createTestApp();
		const post = (body: unknown) =>
			app.request("/api/news/sources", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const created = await post({
			name: " A ",
			url: "https://a.example/feed",
			language: "en",
		});
		expect(created.status).toBe(201);
		const { source } = (await created.json()) as { source: { id: number } };
		expect(source).toMatchObject({ name: "A", enabled: true, language: "en" });

		expect(
			(await post({ name: "B", url: "https://a.example/feed", language: "ja" }))
				.status,
		).toBe(409);
		const bad = await post({
			name: "B",
			url: "ftp://b.example",
			language: "ja",
		});
		expect(bad.status).toBe(400);
		expect(await bad.json()).toMatchObject({ field: "url" });
		expect(
			(await post({ name: "B", url: "https://b.example", language: "fr" }))
				.status,
		).toBe(400);

		const patched = await app.request(`/api/news/sources/${source.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: false }),
		});
		expect(await patched.json()).toMatchObject({ source: { enabled: false } });

		expect(
			(
				await app.request(`/api/news/sources/${source.id}`, {
					method: "DELETE",
				})
			).status,
		).toBe(200);
		expect(
			(
				await app.request(`/api/news/sources/${source.id}`, {
					method: "DELETE",
				})
			).status,
		).toBe(404);
	});

	test("収集間隔の取得と変更", async () => {
		const { app } = createTestApp();
		const get = await app.request("/api/news/settings");
		expect(await get.json()).toEqual({ intervalMinutes: 15 });
		const put = (intervalMinutes: unknown) =>
			app.request("/api/news/settings", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ intervalMinutes }),
			});
		expect((await put(4)).status).toBe(400);
		expect((await put(7.5)).status).toBe(400);
		expect(await (await put(30)).json()).toEqual({ intervalMinutes: 30 });
		expect(await (await app.request("/api/news/status")).json()).toMatchObject({
			intervalMinutes: 30,
		});
	});
});
