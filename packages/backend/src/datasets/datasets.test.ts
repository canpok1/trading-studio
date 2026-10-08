import { describe, expect, test } from "bun:test";
import type { Timeframe } from "@trading-studio/core";
import { TIMEFRAME_MS } from "@trading-studio/core";
import type { Db } from "../db/open";
import { createTestApp } from "../test-app";

const jst = (s: string) => Date.parse(`${s}+09:00`);
const DAY = TIMEFRAME_MS["1d"];

/** from から to まで step ごとに、close を返す関数の値で足を入れる */
function put(
	db: Db,
	timeframe: Timeframe,
	from: number,
	to: number,
	close: (t: number) => number,
) {
	const stmt = db.$client.prepare(
		"insert into candles (timeframe, time, open, high, low, close, volume, source) values (?, ?, ?, ?, ?, ?, 0, 'collect')",
	);
	const step = TIMEFRAME_MS[timeframe];
	db.$client.transaction(() => {
		for (let t = from; t < to; t += step) {
			const c = close(t);
			stmt.run(timeframe, t, close(t - step), c, c, c);
		}
	})();
}

/** from から to まで、1日に r ずつ上がる1分足と日足 */
function market(db: Db, from: number, to: number, r: number) {
	const price = (t: number) =>
		Math.round(10_000_000 * (1 + r) ** ((t - from) / DAY));
	put(db, "1m", from, to, price);
	put(db, "1d", from, to, (t) => price(t + DAY - 1));
}

describe("データセット", () => {
	test("1分足のある月から、終わった2か月ごとに相場のラベルを付けて作る", () => {
		const t = createTestApp();
		market(t.db, jst("2026-07-01T00:00:00"), jst("2026-10-01T00:00:00"), 0.003);
		t.clock.now = jst("2026-10-01T04:00:00");
		expect(t.datasets.build()).toBe(2);
		const list = t.datasets.list();
		expect(list.map((d) => [d.from, d.to, d.regime])).toEqual([
			[jst("2026-08-01T00:00:00"), jst("2026-10-01T00:00:00"), "up"],
			[jst("2026-07-01T00:00:00"), jst("2026-09-01T00:00:00"), "up"],
		]);
		// 作った期間は作り直さない
		expect(t.datasets.build()).toBe(0);
	});

	test("1分足が期間の95%に満たなければ作らない", () => {
		const t = createTestApp();
		const from = jst("2026-07-01T00:00:00");
		const to = jst("2026-09-01T00:00:00");
		// 61日のうち4日欠ける
		market(t.db, from, from + 30 * DAY, 0);
		market(t.db, from + 34 * DAY, to, 0);
		t.clock.now = jst("2026-09-15T00:00:00");
		expect(t.datasets.build()).toBe(0);
	});

	test("日足が1日でも欠ければ作らない", () => {
		const t = createTestApp();
		const from = jst("2026-07-01T00:00:00");
		const to = jst("2026-09-01T00:00:00");
		// 1分足は97%あるが、日足が2日ぶん無い
		market(t.db, from, from + 30 * DAY, 0);
		market(t.db, from + 32 * DAY, to, 0);
		t.clock.now = jst("2026-09-15T00:00:00");
		expect(t.datasets.build()).toBe(0);
	});

	test("月が替わってから1時間は、終わったばかりの期間を作らない", () => {
		const t = createTestApp();
		market(t.db, jst("2026-07-01T00:00:00"), jst("2026-09-01T00:00:00"), 0);
		t.clock.now = jst("2026-09-01T00:30:00");
		expect(t.datasets.build()).toBe(0);
		t.clock.now = jst("2026-09-01T01:00:00");
		expect(t.datasets.build()).toBe(1);
	});

	test("古いニュースを消した期間は、足があってもデータセットにしない", () => {
		const t = createTestApp();
		market(t.db, jst("2026-07-01T00:00:00"), jst("2026-11-01T00:00:00"), 0);
		// 8/1 より前のニュースを消した。7月始まりと8月始まりは遡る記事が欠けている
		t.db.$client.run(
			"insert into settings (key, value) values ('news_deleted_before', ?)",
			[String(jst("2026-08-01T00:00:00"))],
		);
		t.clock.now = jst("2026-11-01T04:00:00");
		expect(t.datasets.build()).toBe(1);
		expect(t.datasets.list()[0]?.from).toBe(jst("2026-09-01T00:00:00"));
	});

	test("相場で絞って返す", async () => {
		const t = createTestApp();
		market(t.db, jst("2026-07-01T00:00:00"), jst("2026-09-01T00:00:00"), 0);
		t.clock.now = jst("2026-09-01T04:00:00");
		t.datasets.build();
		const range = await t.app.request("/api/datasets?regime=range");
		expect(
			((await range.json()) as { datasets: unknown[] }).datasets,
		).toHaveLength(1);
		const up = await t.app.request("/api/datasets?regime=up");
		expect(
			((await up.json()) as { datasets: unknown[] }).datasets,
		).toHaveLength(0);
		const bad = await t.app.request("/api/datasets?regime=bull");
		expect(bad.status).toBe(400);
	});
});
