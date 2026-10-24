import { describe, expect, test } from "bun:test";
import { BTC_JPY, ETH_JPY, TIMEFRAME_MS } from "@trading-studio/core";
import type { LatestMarket } from "../src/market/types-domain";
import { createTestApp } from "./test-app";

const M = TIMEFRAME_MS["1m"];
const DAY = TIMEFRAME_MS["1d"];
// JST 2026-09-26 12:00
const T0 = Date.UTC(2026, 8, 26, 3);

const candle = (time: number, close: number) => ({
	time,
	open: close,
	high: close,
	low: close,
	close,
	volume: 0,
});

async function latest(t: ReturnType<typeof createTestApp>) {
	const res = await t.app.request("/api/market/latest");
	expect(res.status).toBe(200);
	return (await res.json()) as LatestMarket;
}

describe("最新価格の API", () => {
	test("現在値・24時間前の終値・形成中の足・収集の状態を返す", async () => {
		const t = createTestApp();
		t.clock.now = T0 + DAY + 30_000;
		t.marketDataRepo.upsertCollected([
			candle(T0 - M, 90),
			candle(T0, 100),
			candle(T0 + DAY - M, 110),
		]);
		t.live.current = {
			...t.live.current,
			latestTrade: { id: 1, time: T0 + DAY + 20_000, price: 120, quantity: 1 },
			forming: candle(T0 + DAY, 120),
		};
		expect(await latest(t)).toMatchObject({
			price: 120,
			priceTime: T0 + DAY + 20_000,
			price24hAgo: 100,
			forming: { time: T0 + DAY, close: 120 },
			collector: { state: "running" },
		});
	});

	test("約定をまだ受けていなければ、最後に保存した1分足の終値を現在値にする", async () => {
		const t = createTestApp();
		t.clock.now = T0 + 10 * M;
		t.marketDataRepo.upsertCollected([candle(T0, 100)]);
		expect(await latest(t)).toMatchObject({
			price: 100,
			priceTime: T0 + M,
			price24hAgo: null,
		});
	});

	test("データが無ければ現在値は null", async () => {
		const t = createTestApp();
		expect(await latest(t)).toMatchObject({ price: null, priceTime: null });
	});

	test("収集が止まっているとき、その理由といつからかを返す", async () => {
		const t = createTestApp();
		t.live.current = {
			...t.live.current,
			status: {
				state: "stopped",
				stoppedSince: T0,
				error: "取引所との接続が切れた",
				retryAt: T0 + 2_000,
				lastReceivedAt: T0 - 1_000,
			},
		};
		expect((await latest(t)).collector).toEqual({
			state: "stopped",
			stoppedSince: T0,
			error: "取引所との接続が切れた",
			retryAt: T0 + 2_000,
			lastReceivedAt: T0 - 1_000,
		});
	});
});

describe("チャートの足の API", () => {
	test("期間の足と、その前の指定本数の足を古い順に返す", async () => {
		const t = createTestApp();
		t.clock.now = T0 + 2 * DAY;
		const rows = Array.from({ length: 5 }, (_, i) =>
			candle(T0 + i * 12 * 3_600_000, i),
		);
		const id = t.marketDataRepo.createImport("1h", "a.csv", 0);
		t.marketDataRepo.insertImported("1h", rows, id);
		const res = await t.app.request(
			"/api/market/bars?timeframe=1h&range=1d&history=1",
		);
		expect(res.status).toBe(200);
		const { bars } = (await res.json()) as {
			bars: { time: number; close: number }[];
		};
		expect(bars.map((b) => b.close)).toEqual([1, 2, 3, 4]);
	});

	test("足ごとの出来高を返す", async () => {
		const t = createTestApp();
		t.clock.now = T0 + DAY;
		const id = t.marketDataRepo.createImport("1h", "a.csv", 0);
		t.marketDataRepo.insertImported(
			"1h",
			[{ ...candle(T0 + 3_600_000, 1), volume: 12_345_678 }],
			id,
		);
		const res = await t.app.request("/api/market/bars?timeframe=1h&range=1d");
		const { bars } = (await res.json()) as { bars: { volume: number }[] };
		expect(bars.map((b) => b.volume)).toEqual([12_345_678]);
	});

	test("日足で1日を選んでも当日の足が入る", async () => {
		const t = createTestApp();
		t.clock.now = T0;
		const id = t.marketDataRepo.createImport("1d", "a.csv", 0);
		const today = Date.UTC(2026, 8, 25, 15);
		t.marketDataRepo.insertImported("1d", [candle(today, 7)], id);
		const res = await t.app.request("/api/market/bars?timeframe=1d&range=1d");
		const { bars } = (await res.json()) as { bars: { close: number }[] };
		expect(bars.map((b) => b.close)).toEqual([7]);
	});

	test("足が多すぎる組み合わせは断る", async () => {
		const t = createTestApp();
		t.clock.now = T0 + 40 * DAY;
		const id = t.marketDataRepo.createImport("1m", "a.csv", 0);
		t.marketDataRepo.insertImported(
			"1m",
			Array.from({ length: 50_001 }, (_, i) => candle(T0 + i * M, 1)),
			id,
		);
		const res = await t.app.request("/api/market/bars?timeframe=1m&range=all");
		expect(res.status).toBe(400);
		const ok = await t.app.request("/api/market/bars?timeframe=1h&range=all");
		expect(ok.status).toBe(200);
	});

	test("粒度や期間が不正なら 400", async () => {
		const t = createTestApp();
		expect(
			(await t.app.request("/api/market/bars?timeframe=2m&range=1d")).status,
		).toBe(400);
		expect(
			(await t.app.request("/api/market/bars?timeframe=1m&range=2d")).status,
		).toBe(400);
	});
});

describe("銘柄を選んで価格と足を読む", () => {
	const q = (id: string) => `instrument=${encodeURIComponent(id)}`;

	test("指定した銘柄の価格と足を返し、省くか空なら既定の銘柄（BTC/JPY）", async () => {
		const t = createTestApp();
		t.clock.now = T0 + DAY;
		t.marketDataRepo.upsertCollected([candle(T0, 100)]);
		const eth = t.repoOf(ETH_JPY.id);
		eth.upsertCollected([candle(T0, 500_000)]);
		eth.insertImported(
			"1h",
			[candle(T0 + 3_600_000, 510_000)],
			eth.createImport("1h", "a.csv", 0),
		);
		const price = async (query: string) =>
			(
				(await (
					await t.app.request(`/api/market/latest${query}`)
				).json()) as LatestMarket
			).price;
		expect(await price(`?${q(ETH_JPY.id)}`)).toBe(500_000);
		expect(await price("")).toBe(100);
		expect(await price("?instrument=")).toBe(100);

		const bars = async (query: string) =>
			(await (
				await t.app.request(`/api/market/bars?timeframe=1h&range=1d${query}`)
			).json()) as { instrument: { id: string }; bars: { close: number }[] };
		const ethBars = await bars(`&${q(ETH_JPY.id)}`);
		expect(ethBars.instrument.id).toBe(ETH_JPY.id);
		expect(ethBars.bars.map((b) => b.close)).toEqual([510_000]);
		expect((await bars("")).instrument.id).toBe(BTC_JPY.id);
	});

	test("収集していない銘柄は 400", async () => {
		const t = createTestApp();
		const unknown = q("coincheck:doge_jpy");
		expect((await t.app.request(`/api/market/latest?${unknown}`)).status).toBe(
			400,
		);
		expect(
			(await t.app.request(`/api/market/bars?timeframe=1h&range=1d&${unknown}`))
				.status,
		).toBe(400);
	});
});
