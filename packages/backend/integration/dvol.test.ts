import { describe, expect, test } from "bun:test";
import type { DvolBar, DvolStatus } from "../src/dvol/types-domain";
import type { RetentionStatus } from "../src/retention/types-domain";
import { createTestApp } from "./test-app";

const H = 3_600_000;
const DAY = 24 * H;
// 2026-10-18 03:30 UTC
const NOW = Date.UTC(2026, 9, 18, 3, 30);

const bar = (time: number, close = 5000): DvolBar => ({
	time,
	open: close,
	high: close + 100,
	low: close - 100,
	close,
});

/** 開始が [from, to] の1時間足を返す偽物。Deribit と同じく1回に新しいほうから1000本までしか返さない */
function hourlyFeed(close = (_t: number) => 5000) {
	const fetch = async (from: number, to: number) => {
		const out: DvolBar[] = [];
		for (let t = Math.ceil(from / H) * H; t <= to; t += H) {
			out.push(bar(t, close(t)));
		}
		return out.slice(-1000);
	};
	return { fetch };
}

function setup() {
	const t = createTestApp();
	t.clock.now = NOW;
	const times = () =>
		t.dvolRepo
			.bars(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
			.map((b) => b.time);
	const status = async () =>
		(await (await t.app.request("/api/dvol/status")).json()) as DvolStatus;
	return { t, times, status };
}

describe("DVOL の取得", () => {
	test("保持の境目から今までを欠けなく取り込み、1回の問い合わせは1000本まで", async () => {
		const { t, times, status } = setup();
		// 1年にして本数を抑える。境目は 2025-10-18 03:30、最初の足は 04:00
		await t.app.request("/api/retention", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				decisionsDays: 90,
				backtestsDays: null,
				marketDataYears: 1,
			}),
		});
		const feed = hourlyFeed();
		t.dvolFeed.fetch = feed.fetch;
		await t.dvol.run();

		const first = Date.UTC(2025, 9, 18, 4);
		const last = Date.UTC(2026, 9, 18, 3);
		const got = times();
		expect(got[0]).toBe(first);
		expect(got.at(-1)).toBe(last);
		expect(got).toHaveLength((last - first) / H + 1);
		expect(await status()).toMatchObject({
			lastSuccessAt: NOW,
			lastError: null,
			errorSince: null,
			latestBarTime: last,
			nextRunAt: NOW + H,
			running: false,
		});
	});

	test("保持が無期限なら Deribit が持つ最初の 2021-03-24 から取る", async () => {
		const { t, times } = setup();
		await t.app.request("/api/retention", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				decisionsDays: 90,
				backtestsDays: null,
				marketDataYears: null,
			}),
		});
		const feed = hourlyFeed();
		t.dvolFeed.fetch = feed.fetch;
		t.clock.now = Date.UTC(2021, 2, 26);
		await t.dvol.run();
		expect(times()[0]).toBe(Date.UTC(2021, 2, 24));
	});

	test("1時間ごとに最後の足から取り直し、今の足は上書きする", async () => {
		const { t, times, status } = setup();
		t.dvolRepo.save([
			bar(Date.UTC(2026, 9, 18, 2)),
			bar(Date.UTC(2026, 9, 18, 3), 4000),
		]);
		const feed = hourlyFeed((x) =>
			x === Date.UTC(2026, 9, 18, 3) ? 4100 : 5000,
		);
		t.dvolFeed.fetch = feed.fetch;

		t.dvol.tick();
		await t.dvol.run();
		expect(t.dvolRepo.bars(Date.UTC(2026, 9, 18, 3), NOW)[0]?.close).toBe(4100);

		// 1時間たつまでは取らない
		t.clock.now = NOW + H - 1;
		t.dvol.tick();
		expect(t.dvol.status().running).toBe(false);
		expect((await status()).lastSuccessAt).toBe(NOW);

		t.clock.now = NOW + H;
		t.dvol.tick();
		await t.dvol.run();
		expect((await status()).lastSuccessAt).toBe(NOW + H);
		expect(times().at(-1)).toBe(Date.UTC(2026, 9, 18, 4));
	});

	test("失敗は記録して次の回に回し、次の回は保存した最後の足から取り直して欠けを残さない", async () => {
		const { t, times, status } = setup();
		const start = NOW - 3000 * H;
		t.dvolRepo.save([bar(Math.floor(start / H) * H)]);
		const feed = hourlyFeed();
		let n = 0;
		t.dvolFeed.fetch = async (from, to) => {
			n++;
			if (n === 2) throw new Error("HTTP 503");
			return feed.fetch(from, to);
		};
		await t.dvol.run();
		expect(await status()).toMatchObject({
			lastSuccessAt: null,
			lastError: "取得できない: HTTP 503",
			errorSince: NOW,
		});
		const partial = times().at(-1) as number;

		t.clock.now = NOW + H;
		await t.dvol.run();
		expect(await status()).toMatchObject({
			lastSuccessAt: NOW + H,
			lastError: null,
			errorSince: null,
		});
		const got = times();
		expect(got.includes(partial)).toBe(true);
		for (let i = 1; i < got.length; i++) {
			expect((got[i] as number) - (got[i - 1] as number)).toBe(H);
		}
		expect(got.at(-1)).toBe(Date.UTC(2026, 9, 18, 4));
	});

	test("期間の足を古い順に返す。期間が整数でなければ 400", async () => {
		const { t } = setup();
		t.dvolRepo.save([bar(NOW - 2 * H), bar(NOW - H), bar(NOW)]);
		const res = await t.app.request(
			`/api/dvol/bars?from=${NOW - 2 * H}&to=${NOW}`,
		);
		expect(
			((await res.json()) as { bars: DvolBar[] }).bars.map((b) => b.time),
		).toEqual([NOW - 2 * H, NOW - H]);
		expect((await t.app.request("/api/dvol/bars?from=a&to=1")).status).toBe(
			400,
		);
	});

	test("1時間より粗い足の粒度を渡すと、足（JST の区切り）ごとに最後の1時間足だけ返す", async () => {
		const { t } = setup();
		// 2026-10-16 15:00 UTC（JST 10-17 0:00）から 3日分
		const from = Date.UTC(2026, 9, 16, 15);
		t.dvolRepo.save(
			Array.from({ length: 72 }, (_, i) => bar(from + i * H, 5000 + i)),
		);
		const get = async (q: string) =>
			(
				(await (
					await t.app.request(
						`/api/dvol/bars?from=${from}&to=${from + 72 * H}${q}`,
					)
				).json()) as { bars: DvolBar[] }
			).bars.map((b) => b.time);
		expect(await get("&timeframe=1d")).toEqual([
			from + 23 * H,
			from + 47 * H,
			from + 71 * H,
		]);
		expect(await get("&timeframe=4h")).toHaveLength(18);
		expect(await get("&timeframe=1h")).toHaveLength(72);
		expect(
			(await t.app.request(`/api/dvol/bars?from=0&to=1&timeframe=2h`)).status,
		).toBe(400);
	});

	test("毎日の削除で、境目より前で残す相場データの範囲（1時間足と同じ）の外の DVOL を消し、行数に出す", async () => {
		const { t, times } = setup();
		// 2021-10-18 04:00 JST（19:00 UTC の前日）が5年の境目
		const runAt = Date.UTC(2026, 9, 17, 19);
		t.clock.now = runAt - 60_000;
		t.retention.tick();
		const cut = Date.UTC(2021, 9, 16, 19);
		const seg = Number(
			t.db.$client.run(
				"insert into segments (from_time, to_time, regime, return_ppm, volatility_ppm, created_at) values (?, ?, 'up', 0, 0, 0)",
				[cut - 100 * DAY, cut - 40 * DAY],
			).lastInsertRowid,
		);
		const kept = [cut - 135 * DAY, cut - 90 * DAY, cut + DAY];
		t.dvolRepo.save([
			bar(cut - 200 * DAY),
			bar(cut - 136 * DAY),
			...kept.map((x) => bar(x)),
		]);
		t.clock.now = runAt;
		t.retention.tick();
		await t.retention.running();
		expect(times()).toEqual(kept);
		const s = (await (
			await t.app.request("/api/retention")
		).json()) as RetentionStatus;
		expect(s.lastRun?.dvol).toBe(2);
		expect(s.tables.find((x) => x.name === "dvol_bars")).toEqual({
			name: "dvol_bars",
			label: "DVOL",
			rows: 3,
		});
		expect(seg).toBeGreaterThan(0);
	});
});
