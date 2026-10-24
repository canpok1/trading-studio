import { describe, expect, test } from "bun:test";
import { buildPrompt, parseScoreResponse } from "./prompt-domain";

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
			instruments: {},
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

	test("個別に関係する銘柄の点数を銘柄の id で受ける。持続 none の銘柄は入れない", () => {
		expect(
			parseScoreResponse({
				sentiment: 10,
				risk: 5,
				duration: "short",
				instruments: [
					{ symbol: "ETH/JPY", sentiment: -60, risk: 40, duration: "long" },
					{ symbol: "XRP/JPY", sentiment: 30, risk: 0, duration: "none" },
				],
				comment: "c",
			}),
		).toMatchObject({
			scores: { sentiment: 10, risk: 5 },
			instruments: {
				"coincheck:eth_jpy": {
					scores: { sentiment: -60, risk: 40 },
					duration: "long",
				},
			},
		});
		const base = { sentiment: 0, risk: 0, duration: "short", comment: "c" };
		const item = { sentiment: 0, risk: 0, duration: "short" };
		for (const instruments of [
			"ETH/JPY",
			[{ ...item, symbol: "DOGE/JPY" }],
			[{ ...item, symbol: "ETH/JPY", sentiment: 101 }],
			[
				{ ...item, symbol: "ETH/JPY" },
				{ ...item, symbol: "ETH/JPY", duration: "none" },
			],
		]) {
			expect(typeof parseScoreResponse({ ...base, instruments })).toBe(
				"string",
			);
		}
	});

	test("対象の銘柄をプロンプトに並べる", () => {
		expect(
			buildPrompt(
				{ sourceName: "A", title: "t", summary: null, publishedAt: T0 },
				"基準",
			),
		).toContain("対象の銘柄: BTC/JPY・ETH/JPY・XRP/JPY");
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
