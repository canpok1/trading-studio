import { describe, expect, test } from "bun:test";
import type { Candle, ConditionSet } from "@trading-studio/core";
import {
	DEFAULT_BUY_ORDER,
	DEFAULT_PARTIAL_SELL,
	singleBuy,
	TIMEFRAME_MS,
} from "@trading-studio/core";
import { inlineRunner } from "../backtests/inline-runner";
import type { BacktestRun } from "../backtests/types";
import { createTestApp } from "../test-app";
import type { Dataset, DatasetRunDetail, HistoryResult } from "./types";

const H = TIMEFRAME_MS["1h"];
const D = 24 * H;
// JST 2026-08-01 00:00
const START = Date.UTC(2026, 6, 31, 15);
const DAYS = 20;

const PARAMS: ConditionSet = singleBuy({
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
});

// 2日周期で ±5% 動く値動き
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

function setup(runner = inlineRunner()) {
	const t = createTestApp({}, undefined, runner);
	const rows = candles(START, DAYS * 24);
	const id = t.marketDataRepo.createImport("1h", "a.csv", 0);
	t.marketDataRepo.insertImported("1h", rows, id);
	t.marketDataRepo.refillDerived(START, START + DAYS * D, id);
	// 1: 2〜8日 レンジ、2: 8〜14日 上昇、3: 12〜20日 レンジ（2と重なる）
	for (const [i, from, to, regime] of [
		[1, 2, 8, "range"],
		[2, 8, 14, "up"],
		[3, 12, 20, "range"],
	] as const) {
		t.db.$client.run(
			"insert into segments (id, from_time, to_time, regime, return_ppm, volatility_ppm, created_at) values (?, ?, ?, ?, 0, 0, 0)",
			[i, START + from * D, START + to * D, regime],
		);
	}
	return t;
}

async function request(t: T, method: string, path: string, body?: unknown) {
	const res = await t.app.request(path, {
		method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return {
		status: res.status,
		json: (await res.json()) as Record<string, unknown>,
	};
}

const runBody = (datasetId: number, over: Record<string, unknown> = {}) => ({
	datasetId,
	name: "まとめ",
	params: PARAMS,
	initialCash: 2_000_000,
	fees: { limitPpm: 1000, marketPpm: 1000 },
	...over,
});

async function createDataset(t: T, segmentIds = [1, 2, 3]) {
	const r = await request(t, "POST", "/api/datasets", {
		name: "いろいろ",
		segmentIds,
	});
	expect(r.status).toBe(201);
	return r.json.dataset as Dataset;
}

describe("データセット（相場データを束ねたもの）の保存", () => {
	test("作る・上書きする・消す。相場データは新しい順で返す", async () => {
		const t = setup();
		const s = await createDataset(t, [1, 3]);
		expect(s.segments.map((d) => d.id)).toEqual([3, 1]);
		const dup = await request(t, "POST", "/api/datasets", {
			name: "いろいろ",
			segmentIds: [1],
		});
		expect(dup.status).toBe(409);
		const missing = await request(t, "POST", "/api/datasets", {
			name: "別",
			segmentIds: [1, 99],
		});
		expect(missing.status).toBe(400);
		const empty = await request(t, "POST", "/api/datasets", {
			name: "空",
			segmentIds: [],
		});
		expect(empty.status).toBe(400);
		const up = await request(t, "PUT", `/api/datasets/${s.id}`, {
			name: "改名",
			segmentIds: [2],
		});
		expect((up.json.dataset as Dataset).name).toBe("改名");
		const list = await request(t, "GET", "/api/datasets");
		expect((list.json.datasets as Dataset[]).map((x) => x.name)).toEqual([
			"改名",
		]);
		expect((await request(t, "DELETE", `/api/datasets/${s.id}`)).status).toBe(
			200,
		);
		expect((await request(t, "DELETE", `/api/datasets/${s.id}`)).status).toBe(
			404,
		);
	});

	test("消えた相場データは除き、数を返す", async () => {
		const t = setup();
		const s = await createDataset(t, [1, 2]);
		t.db.$client.run("delete from segments where id = 2");
		const got = t.datasets.get(s.id) as Dataset;
		expect(got.segments.map((d) => d.id)).toEqual([1]);
		expect(got.missing).toBe(1);
	});
});

describe("まとめて実行", () => {
	test("相場データごとに古い順に1件ずつ実行し、終わったら合算する", async () => {
		const t = setup();
		const s = await createDataset(t);
		const r = await request(t, "POST", "/api/dataset-runs", runBody(s.id));
		expect(r.status).toBe(202);
		const id = (r.json.run as { id: number }).id;
		await t.datasets.running();
		const detail = (await request(t, "GET", `/api/dataset-runs/${id}`)).json
			.run as DatasetRunDetail;
		expect(detail.status).toBe("done");
		expect(detail.progress).toBe(1);
		expect(detail.runs.map((x) => x.segment?.id)).toEqual([1, 2, 3]);
		expect(detail.runs.every((x) => x.datasetRunId === id)).toBe(true);
		expect(detail.runs.every((x) => x.initialCash === 2_000_000)).toBe(true);
		const sum = detail.summary;
		expect(sum?.count).toBe(3);
		expect(sum?.trades).toBe(
			detail.runs.reduce((n, x) => n + (x.summary?.trades ?? 0), 0),
		);
		expect(sum?.byRegime.map((x) => [x.regime, x.count])).toEqual([
			["up", 1],
			["range", 2],
		]);
		expect(sum?.worstPnlPercent).toBe(
			Math.min(...detail.runs.map((x) => x.summary?.pnlPercent ?? 0)),
		);
	});

	test("履歴はまとめた実行を1行にし、含む実行は出さない", async () => {
		const t = setup();
		const s = await createDataset(t);
		await request(t, "POST", "/api/dataset-runs", runBody(s.id));
		await t.datasets.running();
		await request(t, "POST", "/api/backtests", {
			...runBody(s.id),
			name: "単独",
			from: START + 2 * D,
			to: START + 5 * D,
		});
		await t.backtests.running();
		const h = (await request(t, "GET", "/api/backtests/history"))
			.json as unknown as HistoryResult;
		expect(h.total).toBe(2);
		expect(h.entries.map((e) => e.kind)).toEqual(["run", "dataset"]);
		const q = (await request(t, "GET", "/api/backtests/history?q=まとめ"))
			.json as unknown as HistoryResult;
		expect(q.entries.map((e) => e.kind)).toEqual(["dataset"]);
		// 一覧の API は従来どおり、含む実行も返す
		const all = (await request(t, "GET", "/api/backtests")).json as {
			runs: BacktestRun[];
		};
		expect(all.runs).toHaveLength(4);
	});

	test("実行できない相場データがあれば、どれも実行しない", async () => {
		const t = setup();
		// 足の無い期間の相場データ
		t.db.$client.run(
			"insert into segments (id, from_time, to_time, regime, return_ppm, volatility_ppm, created_at) values (4, ?, ?, 'down', 0, 0, 0)",
			[START + 40 * D, START + 50 * D],
		);
		const s = await createDataset(t, [1, 4]);
		const r = await request(t, "POST", "/api/dataset-runs", runBody(s.id));
		expect(r.status).toBe(409);
		expect(r.json.kind).toBe("blocked");
		const blockers = r.json.blockers as {
			segment: { id: number };
			error: { kind: string };
		}[];
		expect(blockers.map((b) => [b.segment.id, b.error.kind])).toEqual([
			[4, "no_data"],
		]);
		expect(t.datasets.current()).toBeNull();
		const h = (await request(t, "GET", "/api/backtests/history"))
			.json as unknown as HistoryResult;
		expect(h.total).toBe(0);
	});

	test("条件の誤りは相場データごとに並べずに返す", async () => {
		const t = setup();
		const s = await createDataset(t);
		const r = await request(
			t,
			"POST",
			"/api/dataset-runs",
			runBody(s.id, { name: "" }),
		);
		expect(r.status).toBe(400);
		expect(r.json).toMatchObject({ kind: "invalid_input", field: "name" });
	});

	test("中止すると、実行中の相場データを止めて残りは実行しない", async () => {
		let release = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const t = setup(inlineRunner(() => gate));
		const s = await createDataset(t);
		const r = await request(t, "POST", "/api/dataset-runs", runBody(s.id));
		const id = (r.json.run as { id: number }).id;
		// 実行中は単独の実行も、別のまとめた実行も始められない
		expect(
			(await request(t, "POST", "/api/dataset-runs", runBody(s.id))).status,
		).toBe(409);
		expect(t.datasets.current()?.id).toBe(id);
		await request(t, "POST", `/api/dataset-runs/${id}/cancel`);
		release();
		await t.datasets.running();
		const detail = t.datasets.run(id) as DatasetRunDetail;
		expect(detail.status).toBe("canceled");
		expect(detail.runs.map((x) => x.status)).toEqual(["canceled"]);
		expect(detail.summary).toBeNull();
	});
});
