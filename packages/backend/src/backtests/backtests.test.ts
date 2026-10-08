import { describe, expect, test } from "bun:test";
import type {
	Candle,
	ConditionSet,
	SingleBuyConditionSet,
} from "@trading-studio/core";
import {
	DEFAULT_AGGREGATION_RULE,
	DEFAULT_BUY_ORDER,
	DEFAULT_PARTIAL_SELL,
	singleBuy,
	TIMEFRAME_MS,
} from "@trading-studio/core";
import { createTestApp } from "../test-app";
import { inlineRunner } from "./inline-runner";
import type { BacktestRun } from "./types";
import { workerRunner } from "./worker-runner";

const H = TIMEFRAME_MS["1h"];
// JST 2026-08-01 00:00
const START = Date.UTC(2026, 6, 31, 15);
const DAYS = 20;

const FLAT: SingleBuyConditionSet = {
	frequency: {
		flat: { value: 1, unit: "h" },
		holding: { value: 1, unit: "h" },
	},
	orderSize: 1_000_000,
	maxPositions: 1,
	dailyLossLimit: 30_000,
	stopLossCooldownBars: 0,
	stopLossCooldownTimeframe: "1h",
	buy: {
		match: "all",
		conditions: [
			{ type: "breakout", timeframe: "1h", lookback: 5, direction: "high" },
		],
	},
	buyOrder: DEFAULT_BUY_ORDER,
	partialTakeProfit: { match: "all", conditions: [] },
	partialSell: DEFAULT_PARTIAL_SELL,
	takeProfit: {
		match: "any",
		conditions: [{ type: "entryChange", percent: 1, direction: "up" }],
	},
	stopLoss: {
		match: "any",
		conditions: [{ type: "entryChange", percent: 1, direction: "down" }],
	},
};
const PARAMS: ConditionSet = singleBuy(FLAT);

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
	name: "試し",
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
		// チャートは選んだ粒度の足
		const chart = await getJson<{ bars: unknown[] }>(
			t,
			`/api/backtests/${run.id}/chart?timeframe=1h`,
		);
		expect(chart.bars).toHaveLength(18 * 24);
		const daily = await getJson<{ bars: unknown[]; timeframe: string }>(
			t,
			`/api/backtests/${run.id}/chart?timeframe=1d`,
		);
		expect(daily.timeframe).toBe("1d");
		expect(daily.bars.length).toBeLessThanOrEqual(19);
		const res = await t.app.request(
			`/api/backtests/${run.id}/chart?timeframe=1m`,
		);
		expect(res.status).toBe(200);
		expect(
			(await t.app.request(`/api/backtests/${run.id}/chart?timeframe=2h`))
				.status,
		).toBe(400);
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
		}>(t, `/api/backtests/${run.id}/chart?timeframe=1h`);
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
		const bad = await post(
			t,
			body({ params: singleBuy({ ...FLAT, orderSize: 0 }) }),
		);
		expect(bad.status).toBe(400);
		expect(bad.json.kind).toBe("invalid_params");
		const period = await post(
			t,
			body({ from: START + 5 * H, to: START + 5 * H }),
		);
		expect(period.json.field).toBe("period");
		const fee = await post(t, body({ fees: { limitPpm: -1, marketPpm: 0 } }));
		expect(fee.json.field).toBe("fees.limitPpm");
		const name = await post(t, body({ name: " " }));
		expect(name.json.field).toBe("name");
		const shape = await post(t, { params: { foo: 1 } });
		expect(shape.status).toBe(400);
	});

	test("結果の条件は実行時の写しで、新しい戦略として保存できる", async () => {
		const t = setup();
		const s = t.strategies.create({ name: "元", from: { params: PARAMS } });
		if (!s.ok) throw new Error("setup");
		const r = await post(t, body({ name: " 名前付き " }));
		const id = (r.json.run as BacktestRun).id;
		await t.backtests.running();

		// 実行後に戦略を変えても、結果の条件は変わらない
		t.strategies.updateParams(
			s.strategy.id,
			singleBuy({ ...FLAT, orderSize: 2_000_000 }),
		);
		const run = t.backtests.get(id) as BacktestRun;
		expect(run.params.buys[0]?.orderSize).toBe(1_000_000);
		expect(run.name).toBe("名前付き");

		const save = (b: unknown) =>
			t.app.request(`/api/backtests/${id}/save`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(b),
			});
		expect((await save({ overwrite: true })).status).toBe(400);
		expect((await save({ name: "元" })).status).toBe(409);
		const res = await save({ name: "結果から" });
		expect(res.status).toBe(200);
		const created = ((await res.json()) as { strategy: { id: number } })
			.strategy;
		expect(t.strategies.get(created.id)?.params.buys[0]?.orderSize).toBe(
			1_000_000,
		);
		// 保存しても実行の名前は変わらない
		expect((t.backtests.get(id) as BacktestRun).name).toBe("名前付き");
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
			{ scores: { sentiment: 60, risk: 0 }, duration: "short", comment: "c" },
			{
				scoredAt: at,
				criteriaVersion: 1,
				model: "m",
				appBuiltAt: null,
				attempts: 0,
			},
		);
		const rule = t.scoreRepo.aggregationRule();
		t.scoreRepo.setAggregationRule({
			...rule,
			thresholds: {
				...rule.thresholds,
				sentiment: { ...rule.thresholds.sentiment, plus2: 80, plus1: 70 },
			},
		});
		const run = (await post(t, body())).json.run as BacktestRun;
		await t.backtests.running();
		expect(run.aggregationRule?.thresholds.sentiment.plus2).toBe(80);
		expect(run.dailyLossLimitApplied).toBe(true);
		// 1日の損失上限を持つ前の実行は、上限を効かせずに回した結果として読む
		const old = JSON.parse(
			(
				t.db.$client
					.query("select params from backtest_runs where id = ?")
					.get(run.id) as { params: string }
			).params,
		);
		delete old.dailyLossLimit;
		t.db.$client.run("update backtest_runs set params = ? where id = ?", [
			JSON.stringify(old),
			run.id,
		]);
		expect(t.backtests.get(run.id)?.dailyLossLimitApplied).toBe(false);
		// 実行した後にルールを変えても、結果は実行したときのルールで出す
		t.scoreRepo.setAggregationRule(rule);

		const chart = await getJson<{
			bars: { time: number }[];
			judgments: { values: { sentiment: (string | null)[] } };
		}>(t, `/api/backtests/${run.id}/chart?timeframe=1h`);
		const sentiment = chart.judgments.values.sentiment;
		expect(sentiment).toHaveLength(chart.bars.length);
		const i = chart.bars.findIndex((b) => b.time + H >= at);
		expect(sentiment[i - 1]).toBeNull();
		expect(sentiment[i]).toBe("0");
	});
});

describe("AI 判定の条件", () => {
	const withJudgment: ConditionSet = singleBuy({
		...FLAT,
		buy: {
			match: "all",
			conditions: [
				{ type: "judgment", judge: "sentiment", values: ["+2", "+1"] },
			],
		},
	});

	function score(t: T, at: number, sentiment: number, scoredAt = at) {
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
			{ scores: { sentiment, risk: 0 }, duration: "short", comment: "c" },
			{
				scoredAt,
				criteriaVersion: 1,
				model: "m",
				appBuiltAt: null,
				attempts: 0,
			},
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

		score(t, START + 5 * 24 * H, 80);
		const before = await post(t, body({ params: withJudgment }));
		expect(before.json).toMatchObject({
			kind: "no_judgments",
			firstScoredAt: START + 5 * 24 * H,
		});
		// 判定の条件が無ければ今までどおり実行できる
		expect((await post(t, body())).status).toBe(202);
	});

	test("判定の条件で「データなし」を選んでいれば、記録が始まる前はデータなしとして実行する", async () => {
		const t = setup();
		const recorded = START + 5 * 24 * H;
		score(t, recorded, 0);
		const params: ConditionSet = singleBuy({
			...FLAT,
			buy: {
				match: "all",
				conditions: [
					{
						type: "judgment",
						judge: "sentiment",
						values: ["+2", "+1", "none"],
					},
				],
			},
		});
		const r = await post(t, body({ params }));
		expect(r.status).toBe(202);
		const run = r.json.run as BacktestRun;
		await t.backtests.running();
		const orders = await getJson<{
			orders: { side: string; placedAt: number }[];
		}>(t, `/api/backtests/${run.id}/orders?filter=all&limit=200`);
		const buys = orders.orders.filter((o) => o.side === "buy");
		expect(buys.length).toBeGreaterThan(0);
		// 記録の開始後は中立（0）なので買わない
		for (const o of buys) expect(o.placedAt).toBeLessThan(recorded);
	});

	test("評価の時点までに採点済みの点数で判定し、条件どおりに注文を出す", async () => {
		const t = setup();
		// 記録の開始。中立の点数
		score(t, START, 0);
		// +2 の判定になるのは、この採点から集計の期間（24時間）のあいだだけ
		const up = START + 5 * 24 * H;
		score(t, up, 80);
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

	test("記事は採点時刻によらず、公開から取得の間隔の後に使い始め、実行に間隔とニュースの版を残す", async () => {
		const t = setup();
		t.clock.now = START + 30 * 24 * H;
		score(t, START, 0);
		// 公開から10時間たって採点した記事も、公開の15分後（既定の取得の間隔）から使う
		const up = START + 5 * 24 * H;
		const scoredAt = up + 10 * H;
		score(t, up, 80, scoredAt);
		const r = await post(t, body({ params: withJudgment }));
		expect(r.status).toBe(202);
		const run = r.json.run as BacktestRun;
		expect(run.newsDelayMs).toBe(15 * 60_000);
		// 取得・採点のうち最新
		expect(run.newsDataVersion).toBe(scoredAt);
		await t.backtests.running();
		const orders = await getJson<{
			orders: { side: string; placedAt: number }[];
		}>(t, `/api/backtests/${run.id}/orders?filter=all&limit=200`);
		const buys = orders.orders.filter((o) => o.side === "buy");
		expect(buys.some((o) => o.placedAt < scoredAt)).toBe(true);
		for (const o of buys)
			expect(o.placedAt).toBeGreaterThanOrEqual(up + 15 * 60_000);

		// 取得の間隔を変えると、遅れもそれに合わせる。判定の条件が無ければ残さない
		t.newsRepo.setIntervalMinutes(60);
		const slow = await post(t, body({ params: withJudgment }));
		expect((slow.json.run as BacktestRun).newsDelayMs).toBe(60 * 60_000);
		const plain = (await post(t, body())).json.run as BacktestRun;
		expect(plain.newsDelayMs).toBeNull();
		expect(plain.newsDataVersion).toBeNull();
	});

	test("採点の版を指定すると、その版の採点が期間の記事にそろっているときだけ実行し、採点し直した時刻は使い始める時刻に関係しない", async () => {
		const t = setup();
		t.clock.now = START + 30 * 24 * H;
		// 集計に使う一番長い長さを 24 時間にする
		t.scoreRepo.setAggregationRule({
			...DEFAULT_AGGREGATION_RULE,
			halfLifeHours: { short: 6, medium: 6, long: 6 },
		});
		// 記録の開始。期間の頭の集計に使う長さより前なので、市場評価には使わない
		score(t, START, 0);
		const first = START + 3 * 24 * H;
		score(t, first, 0);
		const later = START + 8 * 24 * H;
		score(t, later, 80);
		const v2 = t.scoreRepo.addCriteria("基準2", "改善", 0).version;
		const b = body({ params: withJudgment, criteriaVersion: v2 });

		const missing = await post(t, b);
		expect(missing.status).toBe(409);
		expect(missing.json).toMatchObject({
			kind: "missing_scores",
			version: v2,
			coverage: { total: 2, done: 0, pending: 0, failed: 0 },
		});
		expect(
			(await post(t, body({ params: withJudgment, criteriaVersion: 99 })))
				.status,
		).toBe(400);

		const queued = await t.app.request("/api/scoring/rescore", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ from: b.from, to: b.to, version: v2 }),
		});
		expect(await queued.json()).toMatchObject({
			coverage: { total: 2, done: 0, pending: 2 },
		});
		// 運用（v1）と逆に、v2 では先の記事が強気、後の記事が中立
		const [, a, c] = t.scoreRepo
			.scoredNews(0, Number.MAX_SAFE_INTEGER)
			.map((n) => n.id) as [number, number, number];
		// 採点し直した時刻は後でも、使い始めるのは公開から取得の間隔の後
		const meta = {
			scoredAt: START + 30 * 24 * H,
			model: "m",
			appBuiltAt: null,
			attempts: 0,
		};
		const rescore = (id: number, sentiment: number) =>
			t.scoreRepo.saveRescore(
				id,
				v2,
				{ scores: { sentiment, risk: 0 }, duration: "short", comment: "c" },
				meta,
			);
		rescore(a, 80);
		rescore(c, 0);

		const r = await post(t, b);
		expect(r.status).toBe(202);
		const run = r.json.run as BacktestRun;
		expect(run.criteriaVersion).toBe(v2);
		// 採点し直しもニュースの版に入る
		expect(run.newsDataVersion).toBe(START + 30 * 24 * H);
		await t.backtests.running();
		const orders = await getJson<{
			orders: { side: string; placedAt: number }[];
		}>(t, `/api/backtests/${run.id}/orders?filter=all&limit=200`);
		const buys = orders.orders.filter((o) => o.side === "buy");
		expect(buys.length).toBeGreaterThan(0);
		for (const o of buys) {
			expect(o.placedAt).toBeGreaterThanOrEqual(first);
			expect(o.placedAt).toBeLessThanOrEqual(first + 24 * H);
		}
		// チャートの判定も同じ版で出す
		const chart = await getJson<{
			bars: { time: number }[];
			judgments: { values: { sentiment: (string | null)[] } };
		}>(t, `/api/backtests/${run.id}/chart?timeframe=1h`);
		const i = chart.bars.findIndex((x) => x.time + H >= later);
		expect(chart.judgments.values.sentiment[i]).toBe("0");

		// 判定の条件が無ければ版は使わない
		const plain = await post(t, body({ criteriaVersion: v2 }));
		expect((plain.json.run as BacktestRun).criteriaVersion).toBeNull();
	});
});

test("実行の一覧は件数・名前のキーワード・失敗と中止を除く・損益順で絞れる", async () => {
	const t = createTestApp();
	const insert = t.db.$client.prepare(
		"insert into backtest_runs (strategy_name, params, timeframe, from_time, to_time, initial_cash, fee_limit_ppm, fee_market_ppm, skip_gaps, status, started_at, bar_count, summary) values (?, ?, '1h', 0, 1, 1, 1, 1, 0, ?, 0, 1, ?)",
	);
	const runs: [string, string, number | null][] = [
		["トレンド 100%", "done", 3],
		["トレンド_改善版", "done", -2],
		["レンジ", "failed", null],
		["トレンド", "canceled", null],
		["レンジ 改善版", "done", 8],
	];
	for (const [name, status, pnl] of runs) {
		insert.run(
			name,
			JSON.stringify(PARAMS),
			status,
			pnl === null ? null : JSON.stringify({ pnlPercent: pnl }),
		);
	}
	const ids = async (q = "") => {
		const r = await getJson<{ runs: BacktestRun[]; total: number }>(
			t,
			`/api/backtests${q}`,
		);
		return { ids: r.runs.map((x) => x.id), total: r.total };
	};
	expect(await ids()).toEqual({ ids: [5, 4, 3, 2, 1], total: 5 });
	expect(await ids("?limit=2")).toEqual({ ids: [5, 4], total: 5 });
	// 空白で区切った語はすべて含むもの。% と _ は文字そのものとして探す
	expect(await ids("?q=改善版%20トレンド")).toEqual({ ids: [2], total: 1 });
	expect(await ids("?q=_")).toEqual({ ids: [2], total: 1 });
	expect(await ids("?q=%25")).toEqual({ ids: [1], total: 1 });
	expect(await ids("?hideFailed=1")).toEqual({ ids: [5, 2, 1], total: 3 });
	// 成績の無いものは最後（新しい順）
	expect(await ids("?sort=pnl")).toEqual({ ids: [5, 1, 2, 4, 3], total: 5 });
	expect((await t.app.request("/api/backtests?limit=0")).status).toBe(400);
});
