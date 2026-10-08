import { describe, expect, test } from "bun:test";
import { createTestApp } from "../test-app";
import { nextRunTime } from "./service";
import type { RetentionStatus } from "./types";

const DAY = 86_400_000;
// JST 2026-09-28 04:00
const RUN_AT = Date.UTC(2026, 8, 27, 19);

function setup() {
	const t = createTestApp();
	t.clock.now = RUN_AT - 60_000;
	// 初回の実行時刻は最初に問い合わせた時点から決まる（main では起動時）
	t.retention.tick();
	const sql = t.db.$client;
	const addDecision = (time: number) =>
		Number(
			sql.run(
				"insert into trading_decisions (run_id, mode, strategy_id, strategy_name, time, decision, judgments) values (1, 'paper', 1, 's', ?, '{}', '{}')",
				[time],
			).lastInsertRowid,
		);
	const addOrder = (id: string, decisionId: number) =>
		sql.run(
			"insert into trading_orders (run_id, mode, id, side, type, quantity, placed_at, status, reason, decision_id, strategy_name) values (1, 'paper', ?, 'buy', 'market', 1, 0, 'filled', 'r', ?, 's')",
			[id, decisionId],
		);
	const addRun = (startedAt: number, status = "done") => {
		const id = Number(
			sql.run(
				"insert into backtest_runs (strategy_name, params, timeframe, from_time, to_time, initial_cash, fee_limit_ppm, fee_market_ppm, skip_gaps, status, started_at, bar_count) values ('b', '{}', '1h', 0, 1, 1, 0, 0, 0, ?, ?, 0)",
				[status, startedAt],
			).lastInsertRowid,
		);
		sql.run(
			"insert into backtest_results (run_id, bars, orders, trades, decisions) values (?, x'00', x'00', x'00', x'00')",
			[id],
		);
		return id;
	};
	const addAdvice = (runId: number, status: string) =>
		sql.run(
			"insert into backtest_advice (run_id, status, model, instructions_version, started_at) values (?, ?, 'm', 1, 0)",
			[runId, status],
		);
	const ids = (table: string) =>
		sql
			.query<{ id: number }, []>(`select id from ${table} order by id`)
			.all()
			.map((r) => r.id);
	const status = async () =>
		(await (await t.app.request("/api/retention")).json()) as RetentionStatus;
	const put = (body: unknown) =>
		t.app.request("/api/retention", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const runNow = async () => {
		t.clock.now = RUN_AT;
		t.retention.tick();
		await t.retention.running();
	};
	return {
		t,
		sql,
		addDecision,
		addOrder,
		addRun,
		addAdvice,
		ids,
		status,
		put,
		runNow,
	};
}

describe("古いデータの定期削除", () => {
	test("次の実行は 4:00（JST）", () => {
		expect(nextRunTime(RUN_AT - 1)).toBe(RUN_AT);
		expect(nextRunTime(RUN_AT)).toBe(RUN_AT + DAY);
		expect(nextRunTime(RUN_AT + 1)).toBe(RUN_AT + DAY);
	});

	test("既定では90日より前の判断の記録を消し、注文を出した判断とバックテストは残す", async () => {
		const s = setup();
		const old = s.addDecision(RUN_AT - 91 * DAY);
		const ordered = s.addDecision(RUN_AT - 200 * DAY);
		s.addOrder("o1", ordered);
		const recent = s.addDecision(RUN_AT - 89 * DAY);
		const run = s.addRun(RUN_AT - 1000 * DAY);
		const before = await s.status();
		expect(before.settings).toEqual({
			decisionsDays: 90,
			backtestsDays: null,
			marketDataYears: 5,
		});
		expect(before.nextRunAt).toBe(RUN_AT);
		expect(before.lastRun).toBeNull();

		// 実行時刻の前は消さない
		s.t.retention.tick();
		expect(s.t.retention.running()).toBeNull();

		await s.runNow();
		expect(s.ids("trading_decisions")).toEqual([ordered, recent]);
		expect(s.ids("backtest_runs")).toEqual([run]);
		expect(old).toBeLessThan(ordered);
		const after = await s.status();
		expect(after.lastRun).toEqual({
			at: RUN_AT,
			decisions: 1,
			backtests: 0,
			datasets: 0,
			candles: 0,
			news: 0,
			error: null,
		});
		expect(after.nextRunAt).toBe(RUN_AT + DAY);
		expect(after.tables.find((x) => x.name === "trading_decisions")?.rows).toBe(
			2,
		);
		expect(after.dbBytes).toBeGreaterThan(0);
	});

	test("バックテストの日数を入れると、古い実行を結果・アドバイスごと消す。実行中とアドバイスの生成中は残す", async () => {
		const s = setup();
		const res = await s.put({
			decisionsDays: null,
			backtestsDays: 30,
			marketDataYears: null,
		});
		expect(res.status).toBe(200);
		const old = s.addRun(RUN_AT - 31 * DAY);
		s.addAdvice(old, "done");
		const running = s.addRun(RUN_AT - 31 * DAY, "running");
		const advising = s.addRun(RUN_AT - 31 * DAY);
		s.addAdvice(advising, "running");
		const recent = s.addRun(RUN_AT - 29 * DAY);
		const decision = s.addDecision(RUN_AT - 1000 * DAY);

		await s.runNow();
		expect(s.ids("backtest_runs")).toEqual([running, advising, recent]);
		expect(
			s.sql
				.query<{ run_id: number }, []>(
					"select run_id from backtest_results order by run_id",
				)
				.all()
				.map((r) => r.run_id),
		).toEqual([running, advising, recent]);
		expect(
			s.sql.query("select * from backtest_advice where run_id = ?").all(old),
		).toEqual([]);
		// 判断の記録は無期限にしたので残る
		expect(s.ids("trading_decisions")).toEqual([decision]);
		expect((await s.status()).lastRun?.backtests).toBe(1);
	});

	test("多い判断の記録も分けて消しきる", async () => {
		const s = setup();
		s.sql.transaction(() => {
			for (let i = 0; i < 12_000; i++) s.addDecision(RUN_AT - 100 * DAY - i);
		})();
		await s.runNow();
		expect(s.ids("trading_decisions")).toEqual([]);
		expect((await s.status()).lastRun?.decisions).toBe(12_000);
	});

	test("日数は1〜3650の整数か null", async () => {
		const s = setup();
		for (const bad of [0, 3651, 1.5]) {
			const r = await s.put({
				decisionsDays: bad,
				backtestsDays: null,
				marketDataYears: null,
			});
			expect(r.status).toBe(400);
			expect(((await r.json()) as { field: string }).field).toBe(
				"decisionsDays",
			);
		}
		expect((await s.put({ decisionsDays: 1 })).status).toBe(400);
		for (const bad of [0, 21]) {
			const r = await s.put({
				decisionsDays: null,
				backtestsDays: null,
				marketDataYears: bad,
			});
			expect(((await r.json()) as { field: string }).field).toBe(
				"marketDataYears",
			);
		}
		const ok = await s.put({
			decisionsDays: 180,
			backtestsDays: 365,
			marketDataYears: 10,
		});
		expect(((await ok.json()) as RetentionStatus).settings).toEqual({
			decisionsDays: 180,
			backtestsDays: 365,
			marketDataYears: 10,
		});
	});

	describe("足・ニュース・採点", () => {
		// 2021-09-28 04:00 JST。既定の5年の境目
		const CUT = Date.UTC(2021, 8, 27, 19);

		function seed(s: ReturnType<typeof setup>) {
			const candle = (tf: string, time: number) =>
				s.sql.run(
					"insert into candles (timeframe, time, open, high, low, close, volume, source) values (?, ?, 1, 1, 1, 1, 0, 'collect')",
					[tf, time],
				);
			const dataset = (from: number, to: number, regime: string) =>
				Number(
					s.sql.run(
						"insert into datasets (from_time, to_time, regime, return_ppm, volatility_ppm, created_at) values (?, ?, ?, 0, 0, 0)",
						[from, to, regime],
					).lastInsertRowid,
				);
			let url = 0;
			const news = (publishedAt: number) => {
				const id = Number(
					s.sql.run(
						"insert into news (source_id, source_name, language, url, title, published_at, fetched_at) values (1, 's', 'en', ?, 't', ?, ?)",
						[`u${url++}`, publishedAt, publishedAt],
					).lastInsertRowid,
				);
				s.sql.run(
					"insert into news_scores (news_id, status, scored_at) values (?, 'done', ?)",
					[id, publishedAt],
				);
				return id;
			};
			return { candle, dataset, news };
		}

		const count = (s: ReturnType<typeof setup>, where: string) =>
			s.sql.query<{ n: number }, []>(`select count(*) as n from ${where}`).get()
				?.n;

		test("5年より前のデータセットは相場ごとに最新だけ残し、その期間の足とニュースを残す", async () => {
			const s = setup();
			const { candle, dataset, news } = seed(s);
			const oldUp = dataset(CUT - 300 * DAY, CUT - 240 * DAY, "up");
			const keptUp = dataset(CUT - 200 * DAY, CUT - 140 * DAY, "up");
			const keptDown = dataset(CUT - 400 * DAY, CUT - 340 * DAY, "down");
			const recent = dataset(CUT + 10 * DAY, CUT + 70 * DAY, "up");
			// 消える期間・残すデータセットの期間・境目の後
			for (const t of [
				CUT - 280 * DAY,
				CUT - 190 * DAY,
				CUT - 390 * DAY,
				CUT + DAY,
			]) {
				for (const tf of ["1m", "15m", "1h"]) candle(tf, t);
			}
			const gone = news(CUT - 280 * DAY);
			// データセットの開始の31日前までは残す
			const lead = news(CUT - 230 * DAY);
			const inKept = news(CUT - 190 * DAY);
			const after = news(CUT + DAY);

			await s.runNow();
			expect(s.ids("datasets")).toEqual([keptUp, keptDown, recent]);
			expect(oldUp).toBeLessThan(keptUp);
			// 1時間足は残し、1分・15分足は残すデータセットの期間と境目の後だけ残す
			expect(count(s, "candles where timeframe = '1h'")).toBe(4);
			expect(
				s.sql
					.query<{ time: number }, []>(
						"select distinct time from candles where timeframe in ('1m', '15m') order by time",
					)
					.all()
					.map((r) => r.time),
			).toEqual([CUT - 390 * DAY, CUT - 190 * DAY, CUT + DAY]);
			expect(s.ids("news")).toEqual([lead, inKept, after]);
			expect(gone).toBeLessThan(lead);
			expect(count(s, "news_scores")).toBe(3);
			expect((await s.status()).lastRun).toMatchObject({
				datasets: 1,
				candles: 2,
				news: 1,
			});

			// 記録の始まりは境目から。残したデータセットではその期間の31日前（より後に採点が始まっていればその時点）から
			expect(s.t.judgments.firstScoredAt()).toBe(CUT);
			expect(s.t.judgments.firstScoredAt(CUT - 200 * DAY)).toBe(
				CUT - 230 * DAY,
			);
		});

		test("無期限にすると消さない", async () => {
			const s = setup();
			const { candle, news } = seed(s);
			candle("1m", CUT - 100 * DAY);
			news(CUT - 100 * DAY);
			await s.put({
				decisionsDays: 90,
				backtestsDays: null,
				marketDataYears: null,
			});
			await s.runNow();
			expect(count(s, "candles")).toBe(1);
			expect(count(s, "news")).toBe(1);
			expect(s.t.judgments.firstScoredAt()).toBe(CUT - 100 * DAY);
		});
	});
});
