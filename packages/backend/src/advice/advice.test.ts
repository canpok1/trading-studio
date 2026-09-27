import { describe, expect, test } from "bun:test";
import type { BacktestOrder, Candle, ConditionSet } from "@trading-studio/core";
import { DEFAULT_BUY_ORDER, TIMEFRAME_MS } from "@trading-studio/core";
import type { BacktestRun } from "../backtests/types";
import { createTestApp } from "../test-app";
import { aggregateBars, buildAdviceSource, selectBars } from "./input";
import { buildAdvicePrompt, parseAdviceResponse } from "./prompt";
import { conditionScreenText } from "./screen-text";
import type { BacktestAdvice } from "./types";

const M = TIMEFRAME_MS["1m"];
const H = TIMEFRAME_MS["1h"];
// JST 2026-08-01 00:00
const START = Date.UTC(2026, 6, 31, 15);

const bar = (time: number, close: number) => ({
	time,
	open: close,
	high: close + 10,
	low: close - 10,
	close,
});

const order = (placedAt: number): BacktestOrder => ({
	id: `o${placedAt}`,
	side: "buy",
	type: "market",
	price: null,
	quantity: 1_000_000,
	placedAt,
	status: "filled",
	filledAt: placedAt,
	fillPrice: 100,
	fee: 0,
	canceledAt: null,
	cancelReason: null,
	reason: "テスト",
	pairId: null,
	pnl: null,
});

describe("AI に渡す足", () => {
	const bars = Array.from({ length: 6_000 }, (_, i) =>
		bar(START + i * M, 1_000 + i),
	);

	test("上限以下なら戦略の足をすべて渡す", () => {
		const sel = selectBars(bars.slice(0, 100), "1m", [], 100);
		expect(sel).toEqual({ kind: "all", bars: bars.slice(0, 100) });
	});

	test("上限を超えたら、全体は上限の半分に収まる粗さにまとめ、注文の前後だけ戦略の足で渡す", () => {
		const sel = selectBars(bars, "1m", [order(START + 3_000 * M)], 3_000, 10);
		if (sel.kind !== "reduced") throw new Error("絞られていない");
		// 1分足6000本 → 5分足1200本（15分足より細かく、1500本以下）
		expect(sel.overviewTimeframe).toBe("5m");
		expect(sel.overview).toHaveLength(1_200);
		expect(sel.windows).toHaveLength(1);
		expect(sel.windows[0]?.map((b) => b.time)).toEqual(
			Array.from({ length: 21 }, (_, i) => START + (2_990 + i) * M),
		);
		expect(sel.truncated).toBe(false);
	});

	test("注文の前後が重なれば1つの区間にし、枠に収まらなければ前後の本数を減らす", () => {
		const orders = [order(START + 100 * M), order(START + 105 * M)];
		const wide = selectBars(bars, "1m", orders, 3_000, 10);
		if (wide.kind !== "reduced") throw new Error("絞られていない");
		expect(wide.windows).toHaveLength(1);
		expect(wide.windows[0]).toHaveLength(26);

		// 全体 1200 本、残りの枠 1800 本。100 件の注文の前後 10 本ずつ（2100 本）は収まらず、5 本ずつに減らす
		const many = Array.from({ length: 100 }, (_, i) =>
			order(START + (30 + i * 50) * M),
		);
		const narrow = selectBars(bars, "1m", many, 3_000, 10);
		if (narrow.kind !== "reduced") throw new Error("絞られていない");
		expect(narrow.windowBars).toBe(5);
		expect(narrow.windows.flat()).toHaveLength(1_100);
		expect(narrow.truncated).toBe(false);
	});

	test("まとめた足は始値・高値・安値・終値を引き継ぐ", () => {
		expect(aggregateBars(bars.slice(0, 5), "5m")).toEqual([
			{ time: START, open: 1_000, high: 1_014, low: 990, close: 1_004 },
		]);
	});
});

describe("応答の検証", () => {
	test("見出しがそろっていれば受け付け、欠けていれば理由を投げる", () => {
		const ok = { analysis: " a ", good: "b", bad: "c", improvements: "d" };
		expect(parseAdviceResponse(ok)).toEqual({
			analysis: "a",
			good: "b",
			bad: "c",
			improvements: "d",
		});
		expect(() => parseAdviceResponse({ ...ok, bad: "" })).toThrow("bad");
		expect(() => parseAdviceResponse(null)).toThrow();
	});

	test("差し込む値に差し込み口の文字があっても二重に置き換えない", () => {
		const p = buildAdvicePrompt("{instructions}", "指示");
		expect(p).toContain("<backtest>\n{instructions}\n</backtest>");
	});
});

const PARAMS: ConditionSet = {
	timeframe: "1h",
	frequency: {
		flat: { value: 1, unit: "h" },
		holding: { value: 1, unit: "h" },
	},
	orderSize: 1_000_000,
	maxPositions: 1,
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

function candles(bars: number): Candle[] {
	return Array.from({ length: bars }, (_, i) => {
		const t = START + i * H;
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

type T = ReturnType<typeof createTestApp>;

async function doneRun(t: T): Promise<BacktestRun> {
	const rows = candles(10 * 24);
	const id = t.marketDataRepo.createImport("1h", "a.csv", 0);
	t.marketDataRepo.insertImported("1h", rows, id);
	t.marketDataRepo.refillDerived(START, START + 10 * 24 * H, id);
	const res = await t.app.request("/api/backtests", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name: "試し",
			params: PARAMS,
			from: START + 2 * 24 * H,
			to: START + 10 * 24 * H,
			initialCash: 2_000_000,
			fees: { limitPpm: 1000, marketPpm: 1000 },
		}),
	});
	const run = ((await res.json()) as { run: BacktestRun }).run;
	await t.backtests.running();
	return run;
}

const start = (t: T, id: number) =>
	t.app.request(`/api/advice/runs/${id}`, { method: "POST" });
const read = async (t: T, id: number) =>
	(
		(await (await t.app.request(`/api/advice/runs/${id}`)).json()) as {
			advice: BacktestAdvice | null;
		}
	).advice;

describe("アドバイスの生成", () => {
	test("生成すると、使ったモデル・指示の版と一緒に保存する", async () => {
		const t = createTestApp();
		const run = await doneRun(t);
		expect(await read(t, run.id)).toBeNull();
		const prompts: string[] = [];
		const demo = t.adviceAi.model;
		t.adviceAi.model = {
			unavailable: () => null,
			generate: (m, p, s) => {
				prompts.push(p);
				return demo.generate(m, p, s);
			},
		};

		const res = await start(t, run.id);
		expect(res.status).toBe(202);
		expect(
			((await res.json()) as { advice: BacktestAdvice }).advice.status,
		).toBe("running");
		await t.advice.running(run.id);

		const a = await read(t, run.id);
		expect(a).toMatchObject({
			status: "done",
			model: "gemini-3.8-flash",
			instructionsVersion: 1,
			appBuiltAt: null,
		});
		expect(a?.content?.analysis).toContain("デモの分析");
		// 戦略の足（1時間足）で期間の足をすべて渡す
		expect(prompts[0]).toContain("## 値動き（足の粒度の 1時間足、192 本）");
		expect(prompts[0]).toContain("## 成績");
		// 戦略の条件は画面の見出しと項目名で渡し、プログラムの項目名は渡さない
		expect(prompts[0]).toContain(
			"### 買い注文する条件（組み合わせ方: すべて満たす）\n1. 終値が直近 5 本の最高値を上抜けた",
		);
		expect(prompts[0]).toContain("- 1日の損失上限（円）: 30,000");
		expect(prompts[0]).not.toContain("orderSize");
	});

	test("失敗しても前のアドバイスは残し、理由を出す", async () => {
		const t = createTestApp();
		const run = await doneRun(t);
		await start(t, run.id);
		await t.advice.running(run.id);
		t.adviceAi.model = {
			unavailable: () => null,
			generate: async () => {
				throw new Error("混雑");
			},
		};
		await start(t, run.id);
		await t.advice.running(run.id);
		const a = await read(t, run.id);
		expect(a).toMatchObject({ status: "failed", error: "混雑" });
		expect(a?.content?.analysis).toContain("デモの分析");
	});

	test("生成中・キーが無い・結果の無い実行は始められない", async () => {
		const t = createTestApp();
		const run = await doneRun(t);
		let release = () => {};
		t.adviceAi.model = {
			unavailable: () => null,
			generate: () =>
				new Promise((resolve) => {
					release = () =>
						resolve({ analysis: "a", good: "b", bad: "c", improvements: "d" });
				}),
		};
		expect((await start(t, run.id)).status).toBe(202);
		expect((await start(t, run.id)).status).toBe(409);
		release();
		await t.advice.running(run.id);

		t.adviceAi.model = { ...t.adviceAi.model, unavailable: () => "キーが無い" };
		const noKey = await start(t, run.id);
		expect(noKey.status).toBe(503);
		expect(await noKey.json()).toEqual({ message: "キーが無い" });

		expect((await start(t, 999)).status).toBe(404);
	});
});

describe("アドバイスの設定", () => {
	test("指示は版として足し、使用する版を切り替えられる", async () => {
		const t = createTestApp();
		const post = (json: unknown) =>
			t.app.request("/api/advice/instructions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(json),
			});
		expect((await post({ text: " " })).status).toBe(400);
		const res = await post({ text: "- 短く書く", note: "" });
		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({
			version: { version: 2, text: "- 短く書く", note: "画面から編集" },
		});
		const active = await t.app.request("/api/advice/instructions/active", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ version: 2 }),
		});
		expect(await active.json()).toMatchObject({ activeVersion: 2 });
	});

	test("モデルは選べるものだけ保存できる", async () => {
		const t = createTestApp();
		const put = (model: string) =>
			t.app.request("/api/advice/model", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model }),
			});
		expect((await put("gpt")).status).toBe(400);
		expect(await (await put("gemini-3.1-pro-preview")).json()).toMatchObject({
			current: "gemini-3.1-pro-preview",
		});
	});
});

describe("AI に渡す資料", () => {
	test("取消の理由のカンマで注文の表の列がずれない", () => {
		const o = {
			...order(START),
			status: "canceled" as const,
			filledAt: null,
			canceledAt: START + M,
			cancelReason: "指値 15,000,000 が約定しなかった",
		};
		const text = buildAdviceSource({
			run: {
				params: { ...PARAMS, timeframe: "1m" },
				timeframe: "1m",
				stepTimeframe: "1m",
				stepLimited: false,
				from: START,
				to: START + 2 * M,
				initialCash: 1,
				fees: { limitPpm: 0, marketPpm: 0 },
				summary: null,
				aggregationRule: null,
			} as unknown as BacktestRun,
			bars: [bar(START, 1), bar(START + M, 2)],
			orders: [o],
			judgments: null,
		});
		const table = text.split("## 注文")[1]?.split("\n") ?? [];
		const cols = (line = "") => line.split(",").length;
		expect(cols(table[2])).toBe(cols(table[1]));
		expect(table[2]).toContain("指値 15 000 000 が約定しなかった");
	});

	test("粗い足にまとめたとき、期間の終わりが足の途中なら期間の最後の判定を使う", () => {
		// 1分足88本を5分足18本にまとめる。最後の5分足は3本しか無い
		const bars = Array.from({ length: 88 }, (_, i) => bar(START + i * M, i));
		const trend = bars.map((_, i) => (i === 87 ? "up" : "down") as "up");
		const text = buildAdviceSource(
			{
				run: {
					params: { ...PARAMS, timeframe: "1m" },
					timeframe: "1m",
					stepTimeframe: "1m",
					stepLimited: false,
					from: START,
					to: START + 88 * M,
					initialCash: 1,
					fees: { limitPpm: 0, marketPpm: 0 },
					summary: null,
					aggregationRule: null,
				} as unknown as BacktestRun,
				bars,
				orders: [],
				judgments: {
					from: START,
					step: M,
					firstScoredAt: 0,
					values: {
						trend,
						risk: bars.map(() => "normal" as const),
						sentiment: bars.map(() => "0" as const),
					},
				},
			},
			60,
		);
		const overview = text.split("## 値動きの全体")[1]?.split("\n\n")[0] ?? "";
		expect(overview).toContain("5分足、18 本");
		expect(overview.trim().split("\n").at(-1)).toMatch(/,上昇,平常,0$/);
	});
});

describe("画面の表記", () => {
	test("条件は戦略画面の文言で書く", () => {
		expect(
			conditionScreenText({
				type: "emaCross",
				fast: 12,
				slow: 48,
				direction: "up",
			}),
		).toBe("短期EMA 12 本が 長期EMA 48 本を上抜けた");
		expect(
			conditionScreenText({
				type: "judgment",
				judge: "trend",
				values: ["up", "range"],
			}),
		).toBe("トレンド判定が 上昇・レンジ のどれか");
		expect(
			conditionScreenText({
				type: "rsi",
				period: 14,
				threshold: 30,
				direction: "below",
			}),
		).toBe("RSI 14 本が 30 以下");
	});
});
