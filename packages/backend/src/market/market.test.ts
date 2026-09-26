import { describe, expect, test } from "bun:test";
import { TIMEFRAME_MS } from "@trading-studio/core";
import { createTestApp } from "../test-app";
import type { LatestMarket } from "./types";

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
		expect(bars.map((b) => b.close)).toEqual([2, 3, 4]);
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

describe("運用する戦略", () => {
	const put = (t: ReturnType<typeof createTestApp>, id: number | null) =>
		t.app.request("/api/strategies/active", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id }),
		});
	const get = async (t: ReturnType<typeof createTestApp>) =>
		(
			(await (await t.app.request("/api/strategies/active")).json()) as {
				strategy: { id: number } | null;
			}
		).strategy;

	test("保存・取得でき、戦略を削除すると未選択に戻る", async () => {
		const t = createTestApp();
		expect(await get(t)).toBeNull();
		const r = t.strategies.create({ name: "a", from: { template: "trend" } });
		if (!r.ok) throw new Error("作れない");
		expect((await put(t, r.strategy.id)).status).toBe(200);
		expect((await get(t))?.id).toBe(r.strategy.id);
		expect((await put(t, 999)).status).toBe(404);
		t.strategies.remove(r.strategy.id);
		expect(await get(t)).toBeNull();
	});

	test("null で未選択にできる", async () => {
		const t = createTestApp();
		const r = t.strategies.create({ name: "a", from: { template: "trend" } });
		if (!r.ok) throw new Error("作れない");
		await put(t, r.strategy.id);
		expect((await put(t, null)).status).toBe(200);
		expect(await get(t)).toBeNull();
	});
});
