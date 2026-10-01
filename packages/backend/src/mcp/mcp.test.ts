import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Candle, ConditionSet } from "@trading-studio/core";
import {
	DEFAULT_BUY_ORDER,
	DEFAULT_PARTIAL_SELL,
	TIMEFRAME_MS,
} from "@trading-studio/core";
import { Hono } from "hono";
import { createTestApp } from "../test-app";
import { jst, mcpRoutes, parseTime } from "./server";

const H = TIMEFRAME_MS["1h"];
// JST 2026-08-01 00:00
const START = Date.UTC(2026, 6, 31, 15);

const PARAMS: ConditionSet = {
	timeframe: "1h",
	frequency: {
		flat: { value: 1, unit: "h" },
		holding: { value: 1, unit: "h" },
	},
	orderSize: 1_000_000,
	maxPositions: 1,
	dailyLossLimit: 30_000,
	stopLossCooldownBars: 0,
	buy: {
		match: "all",
		conditions: [{ type: "breakout", lookback: 5, direction: "high" }],
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
			scoring: t.scoring,
			judgments: t.judgments,
			scoringAnalysis: t.scoringAnalysis,
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

describe("parseTime", () => {
	test("日付だけは JST の 0:00、日時はタイムゾーン付きだけ読む", () => {
		expect(parseTime("2026-08-01")).toBe(START);
		expect(parseTime("2026-08-01T00:00:00+09:00")).toBe(START);
		expect(parseTime("2026-07-31T15:00:00Z")).toBe(START);
		expect(parseTime("2026-08-01T00:00:00")).toBeNull();
		expect(parseTime("あした")).toBeNull();
	});
	test("出力は JST の ISO 8601", () => {
		expect(jst(START)).toBe("2026-08-01T00:00:00+09:00");
		expect(jst(START + 123)).toBe("2026-08-01T00:00:00.123+09:00");
	});
});

describe("MCP", () => {
	test("道具の一覧に自動取引や運用する戦略を変えるものは無い", async () => {
		const { client } = await setup();
		const names = (await client.listTools()).tools.map((t) => t.name).sort();
		expect(names).toEqual([
			"add_scoring_criteria",
			"create_strategy",
			"evaluate_judgments",
			"evaluate_news_scores",
			"get_backtest",
			"get_backtest_orders",
			"get_data_coverage",
			"get_guide",
			"get_scoring_setup",
			"get_strategy",
			"list_backtests",
			"list_news_scores",
			"list_strategies",
			"rescore_news",
			"run_backtest",
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
		expect(got.json).toMatchObject({ params: { maxPositions: 3 } });
		expect((got.json as { screenText: string }).screenText).toContain(
			"買値から 1% 下がった",
		);
	});

	test("運用する戦略は変えられない", async () => {
		const { t, call } = await setup();
		const created = await call("create_strategy", {
			name: "運用中",
			params: PARAMS,
		});
		const { id } = created.json as { id: number };
		t.strategies.setActive(id);
		const r = await call("update_strategy", {
			id,
			params: { ...PARAMS, maxPositions: 3 },
		});
		expect(r.isError).toBe(true);
		expect(t.strategies.get(id)?.params.maxPositions).toBe(1);
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
		expect(detail.json).toMatchObject({ id: r.id, params: PARAMS });
		const list = await call("list_backtests");
		expect(list.json).toMatchObject([{ id: r.id }]);
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
				aggregationRule: { windowHours: 24 },
			});
			expect(r.text).toContain("{criteria}");
		});

		test("採点とその後の値動きを並べて読める", async () => {
			const { call } = await scored();
			const r = await call("list_news_scores", {
				from: "2026-08-01",
				to: "2026-08-03",
			});
			const body = r.json as {
				total: number;
				priceTimeframe: string;
				items: {
					title: string;
					status: string;
					criteriaVersion: number;
					returnsAfterScoredPct: Record<string, number | null>;
				}[];
			};
			expect(body.total).toBe(3);
			expect(body.priceTimeframe).toBe("1h");
			expect(body.items[0]).toMatchObject({
				title: "三",
				status: "done",
				criteriaVersion: 1,
			});
			expect(body.items[0]?.returnsAfterScoredPct["1h"]).toBeGreaterThan(0);

			const none = await call("list_news_scores", {
				from: "2026-08-01",
				to: "2026-08-03",
				status: "failed",
			});
			expect(none.json).toMatchObject({ total: 0, items: [] });
		});

		test("点数と判定を値動きと突き合わせて集計できる", async () => {
			const { call } = await scored();
			const scores = await call("evaluate_news_scores", {
				from: "2026-08-01",
				to: "2026-08-03",
			});
			expect(scores.json).toMatchObject({
				newsCount: 3,
				baseline: { "1h": { n: 3, upRatio: 1 } },
				versions: [{ criteriaVersion: 1, count: 3 }],
			});

			const judged = await call("evaluate_judgments", {
				from: "2026-08-02",
				to: "2026-08-03",
			});
			const j = judged.json as {
				hours: number;
				judgedHours: number;
				byJudge: { sentiment: { hours: number }[] };
			};
			expect(j.hours).toBe(24);
			expect(j.judgedHours).toBe(24);
			expect(j.byJudge.sentiment.reduce((a, x) => a + x.hours, 0)).toBe(24);

			const bad = await call("evaluate_judgments", {
				from: "2026-08-02",
				to: "2026-08-03",
				rule: { windowHours: 0, halfLifeHours: 6, thresholds: {} },
			});
			expect(bad.isError).toBe(true);
			const long = await call("evaluate_news_scores", {
				from: "2026-01-01",
				to: "2026-08-03",
			});
			expect(long.isError).toBe(true);
		});

		test("基準の案で試し採点し、版を足して切り替えられる", async () => {
			const { t, call } = await scored();
			const list = await call("list_news_scores", {
				from: "2026-08-01",
				to: "2026-08-03",
			});
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
					news: { id: ids[0], status: "done" },
					trial: { comment: "デモの採点。" },
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
});
