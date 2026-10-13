import { describe, expect, test } from "bun:test";
import type {
	Candle,
	ConditionSet,
	SingleBuyConditionSet,
} from "@trading-studio/core";
import {
	DEFAULT_BUY_ORDER,
	DEFAULT_PARTIAL_SELL,
	singleBuy,
	TIMEFRAME_MS,
} from "@trading-studio/core";
import { DEMO_IMPROVED_STRATEGY } from "../src/advice/fake-model-infra";
import type { BacktestAdvice } from "../src/advice/types-domain";
import type { BacktestRun } from "../src/backtests/types-domain";
import { createTestDb } from "../src/db/test-db-infra";
import { createTestApp } from "./test-app";

const H = TIMEFRAME_MS["1h"];
// JST 2026-08-01 00:00
const START = Date.UTC(2026, 6, 31, 15);

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
		// 条件の足（1時間足）で期間の足をすべて渡す
		expect(prompts[0]).toContain("## 値動き（1時間足、192 本）");
		expect(prompts[0]).toContain("## 成績");
		// 戦略の条件は画面の見出しと項目名で渡し、プログラムの項目名は渡さない
		expect(prompts[0]).toContain(
			"### 買い注文する条件（組み合わせ方: すべて満たす）\n1. 1時間足で 終値が直近 5 本の最高値を上抜けた",
		);
		expect(prompts[0]).toContain("- 1日の損失上限（円）: 30,000");
		expect(prompts[0]).toContain("- 最大ロット数: 1");
		expect(prompts[0]).not.toContain("orderSize");
		// 改善案を反映した戦略も一緒に持つ
		expect(a?.content?.improved).toMatchObject({
			ok: true,
			params: { buys: [{ orderSize: 100_000 }], dailyLossLimit: 100_000 },
		});
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

describe("別の AI で作る", () => {
	const promptOf = async (t: T, id: number) =>
		t.app.request(`/api/advice/runs/${id}/external-prompt`);
	const importAdvice = (t: T, id: number, body: unknown) =>
		t.app.request(`/api/advice/runs/${id}/import`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const answer = {
		analysis: "外の分析",
		good: "- 良い",
		bad: "- 悪い",
		improvements: "- 変える",
		improvedStrategy: DEMO_IMPROVED_STRATEGY,
	};

	test("指示と添付の資料は API キーが無くても出せ、資料は添付だけに入る", async () => {
		const t = createTestApp();
		const run = await doneRun(t);
		t.adviceAi.model = { ...t.adviceAi.model, unavailable: () => "キーが無い" };
		const res = await promptOf(t, run.id);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			prompt: string;
			file: { name: string; content: string };
			instructionsVersion: number;
		};
		expect(body.instructionsVersion).toBe(1);
		expect(body.file.name).toBe(`backtest-${run.id}.md`);
		expect(body.file.content).toStartWith(
			"<backtest>\n## バックテストの実行画面",
		);
		expect(body.file.content).toContain("## 成績");
		expect(body.file.content).toEndWith("</backtest>");
		expect(body.file.content).not.toContain("<instructions>");
		expect(body.prompt).toStartWith(`添付した backtest-${run.id}.md の`);
		expect(body.prompt).not.toContain("## 成績");
		expect(body.prompt).toContain("<instructions>\n- 損益だけでなく");
		expect(body.prompt).toContain("# improvedStrategy の形");
		expect(body.prompt).toContain("最大ロット数");
		expect((await promptOf(t, 999)).status).toBe(404);
	});

	test("貼った答えを取り込むと、名前と指示の版と一緒に最新のアドバイスとして保存する", async () => {
		const t = createTestApp();
		const run = await doneRun(t);
		await start(t, run.id);
		await t.advice.running(run.id);

		const res = await importAdvice(t, run.id, {
			text: `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``,
			model: " ChatGPT ",
			instructionsVersion: 1,
		});
		expect(res.status).toBe(200);
		const a = await read(t, run.id);
		expect(a).toMatchObject({
			status: "done",
			model: "ChatGPT",
			instructionsVersion: 1,
			error: null,
		});
		expect(a?.content?.analysis).toBe("外の分析");
		expect(a?.content?.improved).toMatchObject({ ok: true });

		await importAdvice(t, run.id, {
			text: JSON.stringify(answer),
			model: "",
			instructionsVersion: 1,
		});
		expect((await read(t, run.id))?.model).toBe("外部の AI");
	});

	test("初めてでも取り込め、読めない答え・無い版・生成中は断る", async () => {
		const t = createTestApp();
		const run = await doneRun(t);
		const bad = await importAdvice(t, run.id, {
			text: JSON.stringify({ ...answer, bad: "" }),
			model: "",
			instructionsVersion: 1,
		});
		expect(bad.status).toBe(400);
		expect(await bad.json()).toEqual({ message: "AI の応答に bad が無い" });
		expect(await read(t, run.id)).toBeNull();
		expect(
			(
				await importAdvice(t, run.id, {
					text: JSON.stringify(answer),
					model: "",
					instructionsVersion: 99,
				})
			).status,
		).toBe(400);

		let release = () => {};
		t.adviceAi.model = {
			unavailable: () => null,
			generate: () =>
				new Promise((resolve) => {
					release = () => resolve(answer);
				}),
		};
		await start(t, run.id);
		const busy = await importAdvice(t, run.id, {
			text: JSON.stringify(answer),
			model: "",
			instructionsVersion: 1,
		});
		expect(busy.status).toBe(409);
		release();
		await t.advice.running(run.id);

		const ok = await importAdvice(t, run.id, {
			text: JSON.stringify(answer),
			model: "Claude",
			instructionsVersion: 1,
		});
		expect(ok.status).toBe(200);
	});
});

describe("保存済みの改善版", () => {
	test("買いを複数持つ前の形で保存した改善版は、買い1つの形で読む", async () => {
		const db = createTestDb();
		const t = createTestApp({}, db);
		const run = await doneRun(t);
		await start(t, run.id);
		await t.advice.running(run.id);
		const content = JSON.parse(
			db.$client
				.query<{ content: string }, [number]>(
					"select content from backtest_advice where run_id = ?",
				)
				.get(run.id)?.content as string,
		);
		const { buys, ...rest } = content.improved.params;
		content.improved.params = { ...rest, ...buys[0] };
		db.$client.run("update backtest_advice set content = ? where run_id = ?", [
			JSON.stringify(content),
			run.id,
		]);
		const a = await read(t, run.id);
		expect(a?.content?.improved).toMatchObject({
			ok: true,
			params: { buys: [{ id: "b1", orderSize: 100_000 }] },
		});
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
