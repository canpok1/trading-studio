import { describe, expect, test } from "bun:test";
import type { MarketTrade } from "@trading-studio/core";
import { TIMEFRAME_MS } from "@trading-studio/core";
import { createTestDb } from "../db/test-db";
import { MarketDataRepository } from "../market-data/repository";
import { parseRestTrade, parseWsTrade } from "./coincheck";
import { createCollector } from "./collector";
import { manualFeed } from "./fake-feed";

const M = TIMEFRAME_MS["1m"];
const S = 1_000;
// JST 2026-09-26 12:00
const T0 = Date.UTC(2026, 8, 26, 3);

let nextId = 1;
const tr = (time: number, price: number, quantity = 100): MarketTrade => ({
	id: nextId++,
	time,
	price,
	quantity,
});

function setup(start = T0) {
	let clock = start;
	const repo = new MarketDataRepository(createTestDb());
	const f = manualFeed();
	const collector = createCollector({
		feed: f.feed,
		repo,
		now: () => clock,
	});
	return {
		repo,
		f,
		collector,
		/** 時刻を進めて tick する */
		at(time: number) {
			clock = time;
			collector.tick();
		},
		set(time: number) {
			clock = time;
		},
	};
}

/** 非同期の補完（直近の約定の取得）を終わらせる */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("価格収集", () => {
	test("約定を流すと、分ごとに1分足と粗い足が保存される", async () => {
		const t = setup();
		t.f.ready();
		await flush();
		expect(t.collector.live().status.state).toBe("running");
		t.set(T0 + 10 * S);
		t.f.trades([tr(T0 + 10 * S, 100), tr(T0 + 20 * S, 120)]);
		t.set(T0 + M + 5 * S);
		t.f.trades([tr(T0 + M + 5 * S, 110)]);
		t.collector.tick();
		expect(t.repo.loadCandles("1m", T0, T0 + 10 * M)).toEqual([
			{ time: T0, open: 100, high: 120, low: 100, close: 120, volume: 200 },
		]);
		expect(t.repo.loadCandles("5m", T0, T0 + 10 * M)).toHaveLength(1);
		expect(
			t.repo.loadCandles(
				"1d",
				T0 - TIMEFRAME_MS["1d"],
				T0 + TIMEFRAME_MS["1d"],
			),
		).toHaveLength(1);
		expect(t.collector.live().latestTrade?.price).toBe(110);
		expect(t.collector.live().forming).toMatchObject({
			time: T0 + M,
			close: 110,
		});
	});

	test("受け取った時刻より後の分は確定しない（接続が黙って死んでいる間に横ばいの足を作らない）", async () => {
		const t = setup();
		t.f.ready();
		await flush();
		t.f.trades([tr(T0 + S, 100)]);
		t.at(T0 + 3 * M);
		expect(t.repo.loadCandles("1m", T0, T0 + 10 * M)).toEqual([]);
	});

	test("約定の無い分も、何かを受け取っていれば横ばいの足で埋める", async () => {
		const t = setup();
		t.f.ready();
		await flush();
		t.f.trades([tr(T0 + S, 100)]);
		t.set(T0 + 3 * M + 5 * S);
		t.f.heartbeat();
		t.collector.tick();
		expect(
			t.repo.loadCandles("1m", T0, T0 + 10 * M).map((c) => [c.time, c.volume]),
		).toEqual([
			[T0, 100],
			[T0 + M, 0],
			[T0 + 2 * M, 0],
		]);
	});

	test("CSV の足と同じ日時の足は収集した足で上書きされ、揃った区切りの粗い足も上書きされる", async () => {
		const t = setup();
		const csvCandle = { open: 1, high: 1, low: 1, close: 1, volume: 1 };
		const importId = t.repo.createImport("1m", "a.csv", 0);
		t.repo.insertImported("1m", [{ time: T0, ...csvCandle }], importId);
		const importId5 = t.repo.createImport("5m", "b.csv", 0);
		t.repo.insertImported(
			"5m",
			[
				{ time: T0, ...csvCandle },
				{ time: T0 + 5 * M, ...csvCandle },
			],
			importId5,
		);
		t.f.ready();
		await flush();
		for (let i = 0; i < 6; i++) {
			t.set(T0 + i * M + S);
			t.f.trades([tr(T0 + i * M + S, 100 + i)]);
		}
		t.set(T0 + 6 * M + 5 * S);
		t.f.heartbeat();
		t.collector.tick();
		expect(t.repo.loadCandles("1m", T0, T0 + M)[0]?.close).toBe(100);
		const fives = t.repo.loadCandles("5m", T0, T0 + 10 * M);
		// 1分足が5本揃った区切りは上書きし、1本しかない区切りは取り込んだ足を残す
		expect(fives.map((c) => c.close)).toEqual([104, 1]);
	});

	test("1分足が欠けた区切りでは、1段細かい足が揃って見えても取り込んだ粗い足を残す", () => {
		const repo = new MarketDataRepository(createTestDb());
		const candle = { open: 1, high: 1, low: 1, close: 1, volume: 1 };
		const importId = repo.createImport("1h", "a.csv", 0);
		repo.insertImported("1h", [{ time: T0, ...candle }], importId);
		// 15分ごとに10分ずつしか無い1分足。15分足は4本揃うが、1時間の中の1分足は40本
		const minutes = Array.from({ length: 60 }, (_, i) => i)
			.filter((i) => i % 15 < 10)
			.map((i) => ({ time: T0 + i * M, ...candle, close: 100 }));
		repo.upsertCollected(minutes);
		repo.refillDerived(T0, T0 + 60 * M, null, { overrideImported: true });
		expect(repo.loadCandles("15m", T0, T0 + 60 * M)).toHaveLength(4);
		expect(repo.loadCandles("1h", T0, T0 + 60 * M)[0]?.close).toBe(1);
	});

	test("収集で粗い足を作り直しても、取り込みから作った足の取り込みは外さない", async () => {
		const t = setup();
		const importId = t.repo.createImport("1m", "a.csv", 0);
		const candle = { open: 1, high: 1, low: 1, close: 1, volume: 1 };
		t.repo.insertImported("1m", [{ time: T0 - 10 * M, ...candle }], importId);
		t.repo.refillDerived(T0 - 10 * M, T0 - 9 * M, importId);
		t.f.ready();
		await flush();
		t.set(T0 + S);
		t.f.trades([tr(T0 + S, 100)]);
		t.set(T0 + M + 5 * S);
		t.f.heartbeat();
		t.collector.tick();
		// 取り込みを中止すると、その取り込みの足と、そこから作った足が消える
		t.repo.deleteImported(importId);
		expect(t.repo.loadCandles("5m", T0 - 10 * M, T0 - 5 * M)).toEqual([]);
	});

	test("期間の一部にしか無い収集した1分足は、バックテストの細かい足に選ばない", async () => {
		const t = setup();
		const candle = { open: 1, high: 1, low: 1, close: 1, volume: 1 };
		const importId = t.repo.createImport("1h", "a.csv", 0);
		const H = TIMEFRAME_MS["1h"];
		const hours = Array.from({ length: 24 * 10 }, (_, i) => ({
			time: T0 - 10 * TIMEFRAME_MS["1d"] + i * H,
			...candle,
		}));
		t.repo.insertImported("1h", hours, importId);
		t.f.ready();
		await flush();
		t.set(T0 + S);
		t.f.trades([tr(T0 + S, 100)]);
		t.set(T0 + M + 5 * S);
		t.f.heartbeat();
		t.collector.tick();
		expect(
			t.repo.importedTimeframes(T0 - 10 * TIMEFRAME_MS["1d"], T0 + M),
		).toEqual(["1h"]);
		expect(t.repo.importedTimeframes(T0 - H, T0 + M)).toEqual(["1m", "1h"]);
	});

	test("接続が切れると停止中になり、間隔を延ばしながら再接続して動作中に戻る", async () => {
		const t = setup();
		t.f.ready();
		await flush();
		t.set(T0 + 10 * S);
		t.f.close("テスト切断");
		const stopped = t.collector.live().status;
		expect(stopped).toMatchObject({
			state: "stopped",
			error: "テスト切断",
			stoppedSince: T0 + 10 * S,
			retryAt: T0 + 11 * S,
		});
		t.at(T0 + 11 * S);
		expect(t.f.connects()).toBe(2);
		expect(t.collector.live().status.state).toBe("connecting");
		t.f.close("また切断");
		expect(t.collector.live().status).toMatchObject({
			state: "stopped",
			stoppedSince: T0 + 10 * S,
			retryAt: T0 + 13 * S,
		});
		t.at(T0 + 13 * S);
		t.f.ready();
		await flush();
		expect(t.collector.live().status).toMatchObject({
			state: "running",
			stoppedSince: null,
			error: null,
		});
	});

	test("再接続の間隔の上限は1分", async () => {
		const t = setup();
		let time = T0;
		for (let i = 0; i < 10; i++) {
			t.f.close();
			time = t.collector.live().status.retryAt as number;
			t.at(time);
		}
		t.f.close();
		expect((t.collector.live().status.retryAt as number) - time).toBe(60 * S);
	});

	test("何も届かない時間が続くと、止まったとみなしてつなぎ直す", async () => {
		const t = setup();
		t.f.ready();
		await flush();
		t.at(T0 + 61 * S);
		expect(t.collector.live().status.state).toBe("stopped");
		expect(t.f.connected()).toBe(false);
	});

	test("購読が始まらないまま時間が経つと、止まったとみなす", () => {
		const t = setup();
		t.at(T0 + 31 * S);
		expect(t.collector.live().status.state).toBe("stopped");
	});

	test("再接続の後、直近の約定で補える範囲は補い、補えない期間は欠損として残る", async () => {
		const t = setup();
		t.f.ready();
		await flush();
		t.set(T0 + S);
		t.f.trades([tr(T0 + S, 100)]);
		t.set(T0 + M + 5 * S);
		t.f.heartbeat();
		t.collector.tick();
		// T0+1分台の途中で切れ、T0+10分につなぎ直す。直近の約定は T0+5分10秒 から
		t.set(T0 + M + 10 * S);
		t.f.close();
		t.set(T0 + 10 * M);
		t.f.setRecent([tr(T0 + 5 * M + 10 * S, 200), tr(T0 + 7 * M + S, 210)]);
		t.collector.tick();
		t.f.ready();
		await flush();
		t.set(T0 + 11 * M + 5 * S);
		t.f.heartbeat();
		t.collector.tick();
		const times = t.repo.loadCandles("1m", T0, T0 + 20 * M).map((c) => c.time);
		// T0+5分台は途中からしか分からないので作らない。T0+6分以降は補える
		expect(times).toEqual([
			T0,
			T0 + 6 * M,
			T0 + 7 * M,
			T0 + 8 * M,
			T0 + 9 * M,
			T0 + 10 * M,
		]);
		expect(t.repo.gaps("1m")).toEqual([
			{ from: T0 + M, to: T0 + 6 * M, missing: 5 },
		]);
	});
});

describe("Coincheck の約定の読み取り", () => {
	test("WebSocket の約定を整数へ変換する", () => {
		expect(
			parseWsTrade([
				"1663318663",
				"2357062",
				"btc_jpy",
				"2820896.0",
				"5.0",
				"sell",
				"1193401",
				"2078767",
				null,
			]),
		).toEqual({
			id: 2357062,
			time: 1663318663000,
			price: 2820896,
			quantity: 500_000_000,
		});
		expect(parseWsTrade(["1", "2", "eth_jpy", "1", "1"])).toBeNull();
	});

	test("公開 API の約定を整数へ変換する。指数表記の数量も読む", () => {
		expect(
			parseRestTrade({
				id: 309672161,
				amount: "7.0e-08",
				rate: "13232405.0",
				pair: "btc_jpy",
				created_at: "2026-09-26T08:12:34.000Z",
			}),
		).toEqual({
			id: 309672161,
			time: Date.UTC(2026, 8, 26, 8, 12, 34),
			price: 13232405,
			quantity: 7,
		});
	});
});
