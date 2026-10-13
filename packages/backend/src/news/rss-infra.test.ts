import { describe, expect, test } from "bun:test";
import { parseFeed, SUMMARY_MAX } from "./rss-infra";

const T0 = Date.UTC(2026, 8, 26, 3);

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
