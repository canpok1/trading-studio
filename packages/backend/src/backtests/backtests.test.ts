import { describe, expect, test } from "bun:test";
import type { Candle, ConditionSet } from "@trading-studio/core";
import { DEFAULT_BUY_ORDER, TIMEFRAME_MS } from "@trading-studio/core";
import { createTestApp } from "../test-app";
import { inlineRunner } from "./inline-runner";
import type { BacktestRun } from "./types";
import { workerRunner } from "./worker-runner";

const H = TIMEFRAME_MS["1h"];
// JST 2026-08-01 00:00
const START = Date.UTC(2026, 6, 31, 15);
const DAYS = 20;

const PARAMS: ConditionSet = {
	timeframe: "1h",
	frequency: {
		flat: { value: 1, unit: "h" },
		holding: { value: 1, unit: "h" },
	},
	orderSize: 1_000_000,
	dailyLossLimit: 30_000,
	buy: {
		match: "all",
		conditions: [{ type: "breakout", lookback: 5, direction: "high" }],
	},
	buyOrder: DEFAULT_BUY_ORDER,
	takeProfit: {
		match: "any",
		conditions: [{ type: "entryChange", percent: 1, direction: "up" }],
	},
	stopLoss: {
		match: "any",
		conditions: [{ type: "entryChange", percent: 1, direction: "down" }],
	},
};

// 2日周期で ±5% 動く値動き。買いの指値が約定するよう、安値側のひげを長くする
function candles(from: number, bars: number): Candle[] {
	return Array.from({ length: bars }, (_, i) => {
		const t = from + i * H;
		const close = Math.round(
			10_000_000 *
				(1 + 0.05 * Math.sin((2 * Math.PI * (t - START)) / (48 * H))),
		);
		return {
			time: t,
			open: close,
			high: close + 10_000,
			low: close - 150_000,
			close,
			volume: 1_000_000,
		};
	});
}

type T = ReturnType<typeof createTestApp>;

function importBars(t: T, rows: Candle[], tf: "15m" | "1h" | "1d" = "1h") {
	const id = t.marketDataRepo.createImport(tf, "a.csv", 0);
	t.marketDataRepo.insertImported(tf, rows, id);
	const first = rows[0] as Candle;
	const last = rows.at(-1) as Candle;
	t.marketDataRepo.refillDerived(first.time, last.time + 1, id);
}

const body = (over: Record<string, unknown> = {}) => ({
	strategyId: null,
	params: PARAMS,
	from: START + 2 * 24 * H,
	to: START + DAYS * 24 * H,
	initialCash: 2_000_000,
	fees: { limitPpm: 1000, marketPpm: 1000 },
	...over,
});

async function post(t: T, b: unknown) {
	const res = await t.app.request("/api/backtests", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(b),
	});
	return {
		status: res.status,
		json: (await res.json()) as Record<string, unknown>,
	};
}

async function getJson<R>(t: T, path: string): Promise<R> {
	const res = await t.app.request(path);
	expect(res.status).toBe(200);
	return (await res.json()) as R;
}

function setup(runner = inlineRunner()) {
	const t = createTestApp({}, undefined, runner);
	importBars(t, candles(START, DAYS * 24));
	return t;
}

describe("判定に使う足", () => {
	const often = (params = PARAMS): ConditionSet => ({
		...params,
		frequency: {
			flat: { value: 1, unit: "h" },
			holding: { value: 15, unit: "m" },
		},
	});

	test("判定頻度が戦略の粒度より短ければ、細かい足で判定する", async () => {
		const t = createTestApp({}, undefined, inlineRunner());
		// 1時間足を15分足4本に分けて取り込む
		const q = candles(START, DAYS * 24).flatMap((c) =>
			[0, 1, 2, 3].map((k) => ({ ...c, time: c.time + k * (H / 4) })),
		);
		importBars(t, q, "15m");
		const r = await post(t, body({ params: often() }));
		const run = r.json.run as BacktestRun;
		expect(run).toMatchObject({ stepTimeframe: "15m", stepLimited: false });
		await t.backtests.running();
		const done = (
			await getJson<{ run: BacktestRun }>(t, `/api/backtests/${run.id}`)
		).run;
		expect(done.status).toBe("done");
		// チャートは戦略の粒度の足
		const chart = await getJson<{ bars: unknown[] }>(
			t,
			`/api/backtests/${run.id}/chart`,
		);
		expect(chart.bars).toHaveLength(18 * 24);
	});

	test("細かい足が無ければ、戦略の粒度で判定し、不足として残す", async () => {
		const t = setup();
		const r = await post(t, body({ params: often() }));
		expect(r.json.run).toMatchObject({
			stepTimeframe: "1h",
			stepLimited: true,
		});
	});

	test("判定頻度が戦略の粒度以上なら、戦略の粒度で判定する", async () => {
		const t = setup();
		const r = await post(t, body());
		expect(r.json.run).toMatchObject({
			stepTimeframe: "1h",
			stepLimited: false,
		});
	});
});

describe("バックテストの実行", () => {
	test("実行すると進捗を経て完了し、成績・チャート・注文が取れる", async () => {
		const t = setup();
		const r = await post(t, body());
		expect(r.status).toBe(202);
		const run = r.json.run as BacktestRun;
		expect(run.status).toBe("running");
		expect(run.barCount).toBe(18 * 24);
		await t.backtests.running();

		const done = (
			await getJson<{ run: BacktestRun }>(t, `/api/backtests/${run.id}`)
		).run;
		expect(done.status).toBe("done");
		expect(done.progress).toBe(1);
		expect(done.summary?.trades).toBeGreaterThan(0);
		expect(done.orderCount).toBeGreaterThanOrEqual(done.filledCount);

		const chart = await getJson<{
			bars: { time: number }[];
			markers: { id: string; time: number }[];
		}>(t, `/api/backtests/${run.id}/chart`);
		expect(chart.bars).toHaveLength(18 * 24);
		expect(chart.markers).toHaveLength(done.orderCount);

		const page = await getJson<{
			orders: { id: string; status: string }[];
			total: number;
		}>(t, `/api/backtests/${run.id}/orders?filter=filled&offset=0&limit=3`);
		expect(page.total).toBe(done.filledCount);
		expect(page.orders).toHaveLength(3);
		expect(page.orders.every((o) => o.status === "filled")).toBe(true);
		// 新しい順
		const all = await getJson<{ orders: { id: string }[]; total: number }>(
			t,
			`/api/backtests/${run.id}/orders?limit=200`,
		);
		expect(all.total).toBe(done.orderCount);
		expect(all.orders[0]?.id).toBe(`o${done.orderCount}`);

		const one = await getJson<{ order: { id: string } }>(
			t,
			`/api/backtests/${run.id}/orders/o1`,
		);
		expect(one.order.id).toBe("o1");

		const list = await getJson<{ runs: BacktestRun[] }>(t, "/api/backtests");
		expect(list.runs.map((x) => x.id)).toEqual([run.id]);
	});

	test("実行中の2件目は拒否され、中止できる", async () => {
		let open: () => void = () => {};
		const gate = new Promise<void>((r) => {
			open = r;
		});
		const t = setup(inlineRunner(() => gate));
		const first = await post(t, body());
		const id = (first.json.run as BacktestRun).id;

		const cur = await getJson<{ run: BacktestRun | null }>(
			t,
			"/api/backtests/current",
		);
		expect(cur.run?.id).toBe(id);

		const second = await post(t, body());
		expect(second.status).toBe(409);
		expect(second.json.kind).toBe("busy");

		const res = await t.app.request(`/api/backtests/${id}/cancel`, {
			method: "POST",
		});
		expect(res.status).toBe(200);
		open();
		await t.backtests.running();
		const run = (await getJson<{ run: BacktestRun }>(t, `/api/backtests/${id}`))
			.run;
		expect(run.status).toBe("canceled");
		expect(
			(await getJson<{ run: null }>(t, "/api/backtests/current")).run,
		).toBeNull();
		// 終われば次を実行できる
		expect((await post(t, body())).status).toBe(202);
	});

	test("期間内に欠損があれば確認を求め、飛ばして実行できる", async () => {
		const t = createTestApp();
		const rows = candles(START, DAYS * 24);
		// 5日目の3本を抜く
		importBars(t, [...rows.slice(0, 120), ...rows.slice(123)]);
		const r = await post(t, body());
		expect(r.status).toBe(409);
		expect(r.json.kind).toBe("gaps");
		expect(r.json.gapCount).toBe(1);
		expect(r.json.missingBars).toBe(3);

		const ok = await post(t, body({ skipGaps: true }));
		expect(ok.status).toBe(202);
		await t.backtests.running();
		const run = t.backtests.get((ok.json.run as BacktestRun).id);
		expect(run?.status).toBe("done");
		expect(run?.skipGaps).toBe(true);
	});

	test("データが戦略の粒度より粗い・期間にデータが無い場合は実行しない", async () => {
		const t = createTestApp();
		const daily = Array.from({ length: DAYS }, (_, i) => ({
			...(candles(START, 1)[0] as Candle),
			time: START + i * 24 * H,
		}));
		importBars(t, daily, "1d");
		const coarse = await post(t, body());
		expect(coarse.status).toBe(400);
		expect(coarse.json.kind).toBe("no_data");
		expect(String(coarse.json.message)).toContain("日足");

		const empty = await post(
			t,
			body({ from: START + 100 * 24 * H, to: START + 101 * 24 * H }),
		);
		expect(empty.status).toBe(400);
		expect(empty.json.kind).toBe("no_data");
	});

	test("入力の誤りは実行しない", async () => {
		const t = setup();
		const bad = await post(t, body({ params: { ...PARAMS, orderSize: 0 } }));
		expect(bad.status).toBe(400);
		expect(bad.json.kind).toBe("invalid_params");
		const period = await post(
			t,
			body({ from: START + 5 * H, to: START + 5 * H }),
		);
		expect(period.json.field).toBe("period");
		const fee = await post(t, body({ fees: { limitPpm: -1, marketPpm: 0 } }));
		expect(fee.json.field).toBe("fees.limitPpm");
		const shape = await post(t, { params: { foo: 1 } });
		expect(shape.status).toBe(400);
	});

	test("結果の条件は実行時の写しで、戦略へ上書き・新しい戦略として保存できる", async () => {
		const t = setup();
		const s = t.strategies.create({ name: "元", from: { params: PARAMS } });
		if (!s.ok) throw new Error("setup");
		const r = await post(t, body({ strategyId: s.strategy.id }));
		const id = (r.json.run as BacktestRun).id;
		await t.backtests.running();

		// 実行後に戦略を変えても、結果の条件は変わらない
		const changed = { ...PARAMS, orderSize: 2_000_000 };
		t.strategies.updateParams(s.strategy.id, changed);
		const run = t.backtests.get(id) as BacktestRun;
		expect(run.params.orderSize).toBe(1_000_000);
		expect(run.strategyName).toBe("元");

		const save = (b: unknown) =>
			t.app.request(`/api/backtests/${id}/save`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(b),
			});
		expect((await save({ overwrite: true })).status).toBe(200);
		expect(t.strategies.get(s.strategy.id)?.params.orderSize).toBe(1_000_000);

		expect((await save({ name: "元" })).status).toBe(409);
		const res = await save({ name: "結果から" });
		expect(res.status).toBe(200);
		const created = ((await res.json()) as { strategy: { id: number } })
			.strategy;
		const after = t.backtests.get(id) as BacktestRun;
		expect(after.strategyId).toBe(created.id);
		expect(after.strategyName).toBe("結果から");

		// 元の戦略を消しても実行は残り、上書きはできない
		t.strategies.remove(created.id);
		const orphan = t.backtests.get(id) as BacktestRun;
		expect(orphan.strategyExists).toBe(false);
		expect(orphan.strategyName).toBe("元");
		expect((await save({ overwrite: true })).status).toBe(409);
	});

	test("サーバーが途中で止まった実行は失敗として残す", async () => {
		let open: () => void = () => {};
		const gate = new Promise<void>((r) => {
			open = r;
		});
		const t = setup(inlineRunner(() => gate));
		const r = await post(t, body());
		const id = (r.json.run as BacktestRun).id;
		expect(t.backtestRepo.failInterrupted(9)).toBe(1);
		expect(t.backtestRepo.get(id)?.status).toBe("failed");
		open();
		await t.backtests.running();
	});

	test("Worker で計算しても同じ結果になる", async () => {
		const a = setup();
		const b = setup(workerRunner);
		const ra = await post(a, body());
		const rb = await post(b, body());
		await a.backtests.running();
		await b.backtests.running();
		const sa = a.backtests.get((ra.json.run as BacktestRun).id);
		const sb = b.backtests.get((rb.json.run as BacktestRun).id);
		expect(sb?.status).toBe("done");
		expect(sb?.summary).toEqual(
			sa?.summary as NonNullable<typeof sa>["summary"],
		);
	});
});

describe("チャートの AI 判定", () => {
	test("実行したときの集計ルールで足ごとの判定を出し、採点の記録が始まる前は null", async () => {
		const t = setup();
		t.clock.now = START + 30 * 24 * H;
		const at = START + 10 * 24 * H;
		const source = t.newsRepo.insertSource(
			{ name: "A", url: "https://a.example/feed", language: "ja" },
			0,
		);
		t.newsRepo.saveFetched(
			source,
			[
				{
					title: "a",
					url: "https://a.example/a",
					summary: null,
					publishedAt: at,
				},
			],
			at,
		);
		const id = (t.newsRepo.listNews(1)[0] as { id: number }).id;
		t.scoreRepo.saveScore(
			id,
			{ scores: { trend: 80, risk: null, sentiment: null }, comment: "c" },
			{ scoredAt: at, criteriaVersion: 1, model: "m", attempts: 0 },
		);
		const rule = t.scoreRepo.aggregationRule();
		t.scoreRepo.setAggregationRule({
			...rule,
			thresholds: { ...rule.thresholds, trend: { up: 90, down: 40 } },
		});
		const run = (await post(t, body())).json.run as BacktestRun;
		await t.backtests.running();
		expect(run.aggregationRule?.thresholds.trend.up).toBe(90);
		// 実行した後にルールを変えても、結果は実行したときのルールで出す
		t.scoreRepo.setAggregationRule(rule);

		const chart = await getJson<{
			bars: { time: number }[];
			judgments: { values: { trend: (string | null)[] } };
		}>(t, `/api/backtests/${run.id}/chart`);
		const trend = chart.judgments.values.trend;
		expect(trend).toHaveLength(chart.bars.length);
		const i = chart.bars.findIndex((b) => b.time + H >= at);
		expect(trend[i - 1]).toBeNull();
		expect(trend[i]).toBe("range");
	});
});

describe("AI 判定の条件", () => {
	const withJudgment: ConditionSet = {
		...PARAMS,
		buy: {
			match: "all",
			conditions: [{ type: "judgment", judge: "trend", values: ["up"] }],
		},
	};

	function score(t: T, at: number, trend: number) {
		const source = t.newsRepo.insertSource(
			{ name: `S${at}`, url: `https://a.example/${at}/feed`, language: "ja" },
			0,
		);
		t.newsRepo.saveFetched(
			source,
			[
				{
					title: `n${at}`,
					url: `https://a.example/${at}`,
					summary: null,
					publishedAt: at,
				},
			],
			at,
		);
		const id = (
			t.newsRepo.listNews(100).find((n) => n.title === `n${at}`) as {
				id: number;
			}
		).id;
		t.scoreRepo.saveScore(
			id,
			{ scores: { trend, risk: null, sentiment: null }, comment: "c" },
			{ scoredAt: at, criteriaVersion: 1, model: "m", attempts: 0 },
		);
	}

	test("採点の記録が始まる前を含む期間は、理由と記録の開始を返して実行しない", async () => {
		const t = setup();
		const none = await post(t, body({ params: withJudgment }));
		expect(none.status).toBe(400);
		expect(none.json).toMatchObject({
			kind: "no_judgments",
			firstScoredAt: null,
		});

		score(t, START + 5 * 24 * H, 90);
		const before = await post(t, body({ params: withJudgment }));
		expect(before.json).toMatchObject({
			kind: "no_judgments",
			firstScoredAt: START + 5 * 24 * H,
		});
		// 判定の条件が無ければ今までどおり実行できる
		expect((await post(t, body())).status).toBe(202);
	});

	test("評価の時点までに採点済みの点数で判定し、条件どおりに注文を出す", async () => {
		const t = setup();
		// 記録の開始。中立の点数
		score(t, START, 50);
		// 上昇の判定になるのは、この採点から集計の期間（24時間）のあいだだけ
		const up = START + 5 * 24 * H;
		score(t, up, 90);
		const r = await post(t, body({ params: withJudgment }));
		expect(r.status).toBe(202);
		const run = r.json.run as BacktestRun;
		await t.backtests.running();
		const orders = await getJson<{
			orders: { side: string; placedAt: number }[];
		}>(t, `/api/backtests/${run.id}/orders?filter=all&limit=200`);
		const buys = orders.orders.filter((o) => o.side === "buy");
		expect(buys.length).toBeGreaterThan(0);
		for (const o of buys) {
			expect(o.placedAt).toBeGreaterThanOrEqual(up);
			expect(o.placedAt).toBeLessThanOrEqual(up + 24 * H);
		}
	});
});
