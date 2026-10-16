import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Candle, SingleBuyConditionSet } from "@trading-studio/core";
import {
	DEFAULT_AGGREGATION_RULE,
	DEFAULT_BUY_ORDER,
	DEFAULT_PARTIAL_SELL,
	singleBuy,
	TIMEFRAME_MS,
} from "@trading-studio/core";
import { Hono } from "hono";
import { mcpRoutes } from "../src/mcp/mcp-app";
import { jst } from "../src/mcp/views-domain";
import { createTestApp } from "./test-app";

const H = TIMEFRAME_MS["1h"];
// JST 2026-08-01 00:00
const START = Date.UTC(2026, 6, 31, 15);

// 買いを持つ前の平らな形。MCP は JSON で受け取り、買い1つとして読む
const PARAMS: SingleBuyConditionSet = {
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

function candles(from: number, bars: number): Candle[] {
	return Array.from({ length: bars }, (_, i) => {
		const t = from + i * H;
		const close = Math.round(
			10_000_000 * (1 + 0.05 * Math.sin((2 * Math.PI * i) / 48)),
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

async function setup() {
	const t = createTestApp();
	const app = new Hono().route(
		"/mcp",
		mcpRoutes({
			strategies: t.strategies,
			backtests: t.backtests,
			marketData: t.marketData,
			segments: t.segments,
			datasets: t.datasets,
			scoring: t.scoring,
			news: t.news,
			judgments: t.judgments,
			accuracy: t.scoringAnalysis,
			trading: t.trading,
			market: t.market,
			advice: t.advice,
			calendar: t.calendar,
			inUse: (id) => t.trading.inUse(id),
			sleep: async () => {},
		}),
	);
	const client = new Client({ name: "test", version: "0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
			fetch: async (url, init) => app.request(url.toString(), init),
		}),
	);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const r = await client.callTool({ name, arguments: args });
		const content = r.content as { type: string; text: string }[];
		const body = content[0]?.text ?? "";
		let json: unknown = null;
		try {
			json = JSON.parse(body);
		} catch {}
		return { isError: r.isError === true, text: body, json: json as never };
	};
	return { t, client, call };
}

describe("MCP", () => {
	test("道具の一覧に自動取引や運用する戦略を変えるものは無い", async () => {
		const { client } = await setup();
		const names = (await client.listTools()).tools.map((t) => t.name).sort();
		expect(names).toEqual([
			"add_scoring_criteria",
			"create_strategy",
			"get_backtest",
			"get_backtest_advice",
			"get_backtest_orders",
			"get_data_coverage",
			"get_dataset_run",
			"get_event_setup",
			"get_guide",
			"get_market_evaluation",
			"get_market_evaluation_analysis",
			"get_market_price",
			"get_price_bars",
			"get_scoring_setup",
			"get_strategy",
			"get_strategy_watch",
			"list_backtests",
			"list_datasets",
			"list_events",
			"list_news_scores",
			"list_segments",
			"list_strategies",
			"list_trading_orders",
			"list_trading_runs",
			"preview_aggregation_rule",
			"rescore_news",
			"run_backtest",
			"run_dataset",
			"save_dataset",
			"set_active_scoring_criteria",
			"trial_scoring",
			"update_strategy",
		]);
	});

	test("ガイドに条件の種類とひな形が入る", async () => {
		const { call } = await setup();
		const r = await call("get_guide");
		for (const type of [
			"emaCross",
			"breakout",
			"rsi",
			"rsiCross",
			"entryChange",
			"judgment",
			"emaPosition",
			"emaSlope",
			"bollinger",
			"trailingStop",
			"holdingBars",
		]) {
			expect(r.text).toContain(`"type":"${type}"`);
		}
		expect(r.text).toContain("トレンド追随");
	});

	test("戦略を作って読み、運用中でなければ条件を変えられる", async () => {
		const { call } = await setup();
		const created = await call("create_strategy", {
			name: "相談A",
			params: PARAMS,
		});
		expect(created.isError).toBe(false);
		const { id } = created.json as { id: number };

		const list = await call("list_strategies");
		expect(list.json).toMatchObject([{ id, name: "相談A", active: false }]);

		const updated = await call("update_strategy", {
			id,
			params: { ...PARAMS, maxPositions: 3 },
		});
		expect(updated.isError).toBe(false);
		const got = await call("get_strategy", { id });
		expect(got.json).toMatchObject({
			params: { buys: [{ maxPositions: 3 }] },
		});
		expect((got.json as { screenText: string }).screenText).toContain(
			"買値から 1% 下がった",
		);
	});

	test("タブで運用する戦略に選んでいる戦略は変えられない", async () => {
		const { t, call } = await setup();
		const created = await call("create_strategy", {
			name: "運用中",
			params: PARAMS,
		});
		const { id } = created.json as { id: number };
		t.trading.update(1, { strategyId: id });
		const r = await call("update_strategy", {
			id,
			params: { ...PARAMS, maxPositions: 3 },
		});
		expect(r.isError).toBe(true);
		expect(t.strategies.get(id)?.params.buys[0]?.maxPositions).toBe(1);
	});

	test("条件の誤りと形の誤りはエラーで返す", async () => {
		const { call } = await setup();
		const invalid = await call("create_strategy", {
			name: "誤り",
			params: { ...PARAMS, maxPositions: 99 },
		});
		expect(invalid.isError).toBe(true);
		expect(invalid.text).toContain("maxPositions");
		const shape = await call("create_strategy", {
			name: "形",
			params: { timeframe: "1h" },
		});
		expect(shape.isError).toBe(true);
	});

	test("バックテストを実行して成績と注文を読める", async () => {
		const { t, call } = await setup();
		const rows = candles(START, 20 * 24);
		const importId = t.marketDataRepo.createImport("1h", "a.csv", 0);
		t.marketDataRepo.insertImported("1h", rows, importId);
		t.marketDataRepo.refillDerived(
			START,
			(rows.at(-1) as Candle).time + 1,
			importId,
		);

		const coverage = await call("get_data_coverage");
		expect(coverage.json).toContainEqual(
			expect.objectContaining({ timeframe: "1h", first: jst(START) }),
		);

		const run = await call("run_backtest", {
			name: "相談の試し",
			params: PARAMS,
			from: "2026-08-03",
			to: "2026-08-20",
		});
		expect(run.isError).toBe(false);
		const r = run.json as {
			id: number;
			status: string;
			from: string;
			summary: { trades: number };
		};
		expect(r.status).toBe("done");
		expect(r.from).toBe("2026-08-03T00:00:00+09:00");
		expect(r.summary.trades).toBeGreaterThan(0);

		const orders = await call("get_backtest_orders", { id: r.id });
		expect((orders.json as { total: number }).total).toBeGreaterThan(0);
		const detail = await call("get_backtest", { id: r.id });
		expect(detail.json).toMatchObject({ id: r.id, params: singleBuy(PARAMS) });
		expect(detail.json).toMatchObject({
			summary: { grades: { maxDrawdown: expect.any(String) } },
		});
		const list = await call("list_backtests");
		expect(list.json).toMatchObject({
			total: 1,
			entries: [{ kind: "run", id: r.id }],
		});
		expect(await call("list_backtests", { q: "別の名前" })).toMatchObject({
			json: { total: 0, entries: [] },
		});
		expect(await call("get_backtest_advice", { id: r.id })).toMatchObject({
			json: null,
		});
		await t.advice.start(r.id);
		const advice = await call("get_backtest_advice", { id: r.id });
		expect(advice.json).toMatchObject({ status: expect.any(String) });

		// 相場データで期間を選ぶ
		t.db.$client.run(
			"insert into segments (id, from_time, to_time, regime, return_ppm, volatility_ppm, created_at) values (3, ?, ?, 'up', 150000, 20000, 0)",
			[START + 2 * 24 * H, START + 19 * 24 * H],
		);
		const segments = await call("list_segments", { regime: "up" });
		expect(segments.json as unknown[]).toEqual([
			{
				id: 3,
				from: "2026-08-03T00:00:00+09:00",
				to: "2026-08-20T00:00:00+09:00",
				regime: "up",
				label: "上昇相場",
				returnPercent: 15,
				volatilityPercent: 2,
			},
		]);
		const bySegment = await call("run_backtest", {
			name: "相場データで",
			params: PARAMS,
			segmentId: 3,
		});
		expect(bySegment.json).toMatchObject({
			from: "2026-08-03T00:00:00+09:00",
			segment: { id: 3, regime: "上昇相場" },
		});

		// 相場データを束ねたデータセットでまとめて実行する
		const saved = await call("save_dataset", {
			name: "上昇だけ",
			segmentIds: [3],
		});
		const datasetId = (saved.json as { id: number }).id;
		expect(await call("list_datasets")).toMatchObject({
			json: [{ id: datasetId, name: "上昇だけ", missing: 0 }],
		});
		const all = await call("run_dataset", {
			datasetId,
			name: "まとめ",
			params: PARAMS,
		});
		const grouped = all.json as {
			id: number;
			status: string;
			summary: { count: number; byRegime: { regime: string }[] };
			runs: { segment: { id: number } }[];
		};
		expect(grouped.status).toBe("done");
		expect(grouped.summary.count).toBe(1);
		expect(grouped.summary.byRegime[0]?.regime).toBe("上昇相場");
		expect(grouped.runs.map((x) => x.segment.id)).toEqual([3]);
		expect(await call("get_dataset_run", { id: grouped.id })).toMatchObject({
			json: { id: grouped.id, status: "done" },
		});
		// 履歴ではまとめた実行を1行にし、含む実行は出さない
		const history = (await call("list_backtests", { limit: 100 })).json as {
			entries: { kind: string; id: number }[];
		};
		expect(history.entries.filter((e) => e.kind === "dataset")).toEqual([
			expect.objectContaining({ id: grouped.id }),
		]);
		const memberId = (all.json as { runs: { id: number }[] }).runs[0]?.id;
		expect(
			history.entries.filter((e) => e.kind === "run").map((e) => e.id),
		).not.toContain(memberId);
	});

	test("ホームのタブの口座・成績・注文・戦略の見張り、価格とチャートの足を読める", async () => {
		const { t, call } = await setup();
		const M = TIMEFRAME_MS["1m"];
		const T0 = 1_800_000_000_000;
		const P = 10_000_000;
		t.clock.now = T0 + 30_000;
		t.marketDataRepo.upsertCollected(
			Array.from({ length: 5 }, (_, i) => ({
				time: T0 - (5 - i) * M,
				open: P,
				high: P + 1_000,
				low: P - 1_000,
				close: P,
				volume: 2_000_000,
			})),
		);
		const trade = (id: number, price: number) => ({
			id,
			time: t.clock.now,
			price,
			quantity: 1,
		});
		t.live.current = { ...t.live.current, latestTrade: trade(1, P) };
		const created = await call("create_strategy", {
			name: "毎分買う",
			params: {
				...PARAMS,
				frequency: {
					flat: { value: 1, unit: "m" },
					holding: { value: 1, unit: "m" },
				},
				buy: {
					match: "all",
					conditions: [
						{ type: "judgment", judge: "sentiment", values: ["none"] },
					],
				},
				buyOrder: { type: "market" },
			},
		});
		const strategyId = (created.json as { id: number }).id;
		t.trading.update(1, { strategyId });
		expect(t.trading.start(1).ok).toBe(true);
		t.clock.now = T0 + M;
		t.trading.tick();
		t.live.current = { ...t.live.current, latestTrade: trade(2, P) };
		t.trading.onTrades([trade(2, P)]);
		t.live.current = { ...t.live.current, latestTrade: trade(3, P + 50_000) };

		const runs = (await call("list_trading_runs")).json as {
			id: number;
			mode: string;
			enabled: boolean;
			unrealizedPnl: number;
			account: { lots: { unrealizedPnl: number }[] };
			performance: { grades: { maxDrawdown: string } };
		}[];
		expect(runs[0]).toMatchObject({
			id: 1,
			mode: "paper",
			modeLabel: "デモ",
			enabled: true,
			strategy: { id: strategyId, name: "毎分買う" },
		});
		// 0.01 BTC を 1,000万円で買い、今 1,005万円
		expect(runs[0]?.unrealizedPnl).toBe(500);
		expect(runs[0]?.account.lots[0]?.unrealizedPnl).toBe(500);
		expect(runs[0]?.performance.grades.maxDrawdown).toBe("優秀");

		const orders = await call("list_trading_orders", { runId: 1 });
		expect(orders.json).toMatchObject({
			total: 1,
			orders: [{ side: "buy", status: "filled", fillPrice: P, judgments: {} }],
		});
		const watch = await call("get_strategy_watch", { runId: 1 });
		expect(watch.isError).toBe(false);
		expect(watch.json).toMatchObject({
			price: P + 50_000,
			nextMoves: { up: { kind: "takeProfit", distancePercent: 0.5 } },
			buys: [{ lots: [{ entryPrice: P }] }],
		});
		expect(watch.text).toContain("買値から 1% 下がった");
		expect((await call("list_trading_orders", { runId: 99 })).isError).toBe(
			true,
		);

		const live = t.trading.create({ name: "リアル", mode: "live", strategyId });
		if (!live.ok) throw new Error();
		const liveRow = (
			(await call("list_trading_runs")).json as Record<string, unknown>[]
		).find((r) => r.id === live.status.id);
		expect(liveRow).not.toHaveProperty("account");
		expect(
			(await call("get_strategy_watch", { runId: live.status.id })).isError,
		).toBe(true);

		expect(await call("get_market_price")).toMatchObject({
			json: {
				price: P + 50_000,
				price24hAgo: null,
				collector: { state: "running" },
			},
		});
		const bars = await call("get_price_bars", {
			timeframe: "1m",
			range: "1d",
			limit: 3,
		});
		expect(bars.json).toMatchObject({
			total: 5,
			firstScoredAt: null,
			bars: [
				{ close: P, volume: 2_000_000, marketEvaluation: { sentiment: null } },
				{},
				{ time: jst(T0 - M) },
			],
		});
	});

	test("strategyId と params の両方、日付の誤りはエラー", async () => {
		const { call } = await setup();
		const both = await call("run_backtest", {
			name: "x",
			strategyId: 1,
			params: PARAMS,
			from: "2026-08-03",
			to: "2026-08-20",
		});
		expect(both.isError).toBe(true);
		const date = await call("run_backtest", {
			name: "x",
			params: PARAMS,
			from: "2026-08-03T00:00:00",
			to: "2026-08-20",
		});
		expect(date.isError).toBe(true);
		const mixed = await call("run_backtest", {
			name: "x",
			params: PARAMS,
			from: "2026-08-03",
			to: "2026-08-20",
			segmentId: 1,
		});
		expect(mixed.isError).toBe(true);
	});

	describe("ニュースの採点", () => {
		/** 1時間足で上がり続ける値動きと、採点済みのニュース3件を用意する */
		async function scored() {
			const s = await setup();
			const { t } = s;
			const rows = Array.from({ length: 5 * 24 }, (_, i) => {
				const close = 10_000_000 + i * 10_000;
				return {
					time: START + i * H,
					open: close,
					high: close,
					low: close,
					close,
					volume: 1_000_000,
				};
			});
			const importId = t.marketDataRepo.createImport("1h", "a.csv", 0);
			t.marketDataRepo.insertImported("1h", rows, importId);
			const source = t.newsRepo.insertSource(
				{ name: "A", url: "https://a.example/feed", language: "ja" },
				0,
			);
			t.clock.now = START + 24 * H;
			t.newsRepo.saveFetched(
				source,
				["一", "二", "三"].map((title, i) => ({
					title,
					url: `https://a.example/${i}`,
					summary: null,
					publishedAt: START + (20 + i) * H,
				})),
				t.clock.now,
			);
			for (let i = 0; i < 3; i++) {
				t.scorer.tick();
				await t.scorer.idle();
			}
			t.clock.now = START + 4 * 24 * H;
			return s;
		}

		test("仕組みと今の基準を読める", async () => {
			const { call } = await setup();
			const r = await call("get_scoring_setup");
			expect(r.json).toMatchObject({
				criteria: [{ version: 1, active: true }],
				aggregationRule: { halfLifeHours: { short: 6, medium: 24, long: 72 } },
			});
			expect(r.text).toContain("{criteria}");
		});

		test("採点・重み・精度を、画面と同じ条件で絞って読める", async () => {
			const { call } = await scored();
			const r = await call("list_news_scores", {
				from: "2026-08-01",
				to: "2026-08-02",
			});
			const body = r.json as {
				total: number;
				evaluationTime: string;
				precisionHorizon: string;
				items: {
					title: string;
					status: string;
					criteriaVersion: number;
					weight: number;
					precision: { sentiment: number; risk: number };
				}[];
			};
			expect(body.total).toBe(3);
			// to が今より前なので、市場評価の時点は to
			expect(body.evaluationTime).toBe("2026-08-02T00:00:00+09:00");
			expect(body.precisionHorizon).toBe("24h");
			expect(body.items[0]).toMatchObject({
				title: "三",
				status: "done",
				criteriaVersion: 1,
			});
			expect(body.items[0]?.weight).toBeGreaterThan(0);
			expect(body.items[0]?.precision.sentiment).toBeGreaterThanOrEqual(1);

			const q = await call("list_news_scores", { q: "二" });
			expect(q.json).toMatchObject({ total: 1, items: [{ title: "二" }] });
			// 今は短期の半減期の4倍より後なので、評価に使っている記事は無い
			const active = await call("list_news_scores", { active: true });
			expect(active.json).toMatchObject({ total: 0 });
			const page = await call("list_news_scores", { offset: 2, limit: 5 });
			expect(page.json).toMatchObject({ total: 3, items: [{ title: "一" }] });
			const bad = await call("list_news_scores", { from: "8/1" });
			expect(bad.isError).toBe(true);
		});

		test("市場評価と内訳、評価ルールの案での市場評価を読める", async () => {
			const { call } = await scored();
			const r = await call("get_market_evaluation", { at: "2026-08-02" });
			const body = r.json as {
				time: string;
				results: { sentiment: { label: string; count: number } };
				breakdown: { risk: { label: string; count: number }[] };
			};
			expect(body.time).toBe("2026-08-02T00:00:00+09:00");
			expect(body.results.sentiment.count).toBe(3);
			expect(body.breakdown.risk.map((x) => x.label)).toEqual([
				"危機",
				"かなり警戒",
				"警戒",
				"やや警戒",
				"平常",
			]);
			expect(body.breakdown.risk.reduce((a, x) => a + x.count, 0)).toBe(3);

			const bad = await call("get_market_evaluation", { at: "あした" });
			expect(bad.isError).toBe(true);

			const preview = await call("preview_aggregation_rule", {
				rule: DEFAULT_AGGREGATION_RULE,
			});
			expect(preview.isError).toBe(false);
			expect(preview.json).toMatchObject({
				results: { risk: { count: 0, label: "平常" } },
			});
			const wrong = await call("preview_aggregation_rule", {
				rule: { halfLifeHours: 6, thresholds: {} },
			});
			expect(wrong.isError).toBe(true);
		});

		test("市場評価の分析を画面の3つの見せ方で読める", async () => {
			const { call } = await scored();
			const r = await call("get_market_evaluation_analysis");
			const body = r.json as {
				settings: { horizon: string; periodDays: number };
				results: {
					sentiment: {
						count: number;
						byPrecision: { precision: number; count: number }[];
						byLevel: { count: number }[];
						byLevelAndMove: { moves: { move: string; count: number }[] }[];
					};
				};
			};
			expect(body.settings).toMatchObject({ horizon: "24h", periodDays: 30 });
			const s = body.results.sentiment;
			expect(s.count).toBe(3);
			expect(s.byPrecision.map((x) => x.precision)).toEqual([5, 4, 3, 2, 1]);
			expect(s.byPrecision.reduce((a, x) => a + x.count, 0)).toBe(3);
			expect(s.byLevel.reduce((a, x) => a + x.count, 0)).toBe(3);
			// 値動きはずっと上がっている
			expect(
				s.byLevelAndMove.flatMap((x) =>
					x.moves.filter((m) => m.count > 0).map((m) => m.move),
				),
			).toEqual(expect.arrayContaining([expect.stringContaining("上昇")]));
		});

		test("市場評価の分析をプロンプトの版とアプリのバージョンとモデルで絞れる", async () => {
			const { t, call } = await scored();
			const built = Date.parse("2026-10-07T12:05:00Z");
			t.db.$client
				.query(
					"update news_scores set criteria_version = 2, app_built_at = ?, model = 'openai:a' where news_id = (select min(news_id) from news_scores)",
				)
				.run(built);
			const all = (await call("get_market_evaluation_analysis")).json as {
				options: {
					criteriaVersions: { version: number; count: number }[];
					appVersions: { version: string; count: number }[];
					models: { model: string; count: number; active: boolean }[];
				};
			};
			expect(all.options.criteriaVersions).toMatchObject([
				{ version: 2, count: 1 },
				{ version: 1, count: 2 },
			]);
			expect(all.options.appVersions).toEqual([
				{ version: "2026-10-07T21:05:00+09:00", count: 1 },
				{ version: "none", count: 2 },
			]);
			expect(all.options.models).toEqual([
				{ model: expect.any(String), count: 2, active: true },
				{ model: "openai:a", count: 1, active: false },
			]);
			const count = async (a: Record<string, unknown>) =>
				(
					(await call("get_market_evaluation_analysis", a)).json as {
						results: { risk: { count: number } };
					}
				).results.risk.count;
			expect(await count({ criteriaVersion: 1 })).toBe(2);
			expect(await count({ appVersion: "2026-10-07T21:05:00+09:00" })).toBe(1);
			expect(await count({ appVersion: "none", criteriaVersion: 2 })).toBe(0);
			expect(await count({ model: "openai:a" })).toBe(1);
			expect(await count({ model: "none" })).toBe(0);
			expect(
				(await call("get_market_evaluation_analysis", { appVersion: "x" }))
					.isError,
			).toBe(true);
		});

		test("基準の案で試し採点し、版を足して切り替えられる", async () => {
			const { t, call } = await scored();
			const list = await call("list_news_scores");
			const ids = (list.json as { items: { id: number }[] }).items.map(
				(x) => x.id,
			);
			const trial = await call("trial_scoring", {
				criteria: "案",
				newsIds: ids.slice(0, 2),
			});
			expect(trial.isError).toBe(false);
			expect(trial.json).toMatchObject([
				{
					news: { id: ids[0] },
					result: { ok: true, comment: "デモの採点。" },
				},
				{ news: { id: ids[1] } },
			]);
			// 試し採点は保存しない
			expect(t.scoreRepo.listCriteria()).toHaveLength(1);

			const added = await call("add_scoring_criteria", {
				text: "新しい基準",
				note: "リスクを厳しく",
			});
			expect(added.json).toMatchObject({ version: 2, note: "リスクを厳しく" });
			expect(t.scoreRepo.activeCriteriaVersion()).toBe(1);

			const set = await call("set_active_scoring_criteria", { version: 2 });
			expect(set.json).toMatchObject({ activeVersion: 2 });
			expect(t.scoreRepo.activeCriteriaVersion()).toBe(2);
			const missing = await call("set_active_scoring_criteria", {
				version: 9,
			});
			expect(missing.isError).toBe(true);
		});
	});

	describe("予定", () => {
		test("予定の仕組みと、予定ごとの重要度の判断を読める", async () => {
			const { call } = await setup();
			const setup1 = await call("get_event_setup");
			expect(setup1.json).toMatchObject({
				sources: [],
				criteria: [{ version: 1, active: true }],
			});
			expect((setup1.json as { template: string }).template).toContain(
				"{event}",
			);
			const r = await call("list_events", {
				from: "2026-01-28",
				to: "2026-01-30",
			});
			expect(r.isError).toBe(false);
			const items = (r.json as { items: { title: string }[] }).items;
			expect(items.map((e) => e.title)).toEqual([
				expect.stringContaining("FOMC 声明"),
			]);
			expect(r.json).toMatchObject({
				version: 1,
				items: [
					{
						start: "2026-01-29T04:00:00+09:00",
						source: "アプリが持つ過去の予定",
						judgment: { status: "waiting" },
					},
				],
			});
			const bad = await call("list_events", { from: "x", to: "2026-01-30" });
			expect(bad.isError).toBe(true);
		});
	});
});
