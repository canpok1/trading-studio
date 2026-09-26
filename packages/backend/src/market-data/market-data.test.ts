import { describe, expect, test } from "bun:test";
import { TIMEFRAME_MS } from "@trading-studio/core";
import { createTestApp } from "../test-app";
import type { ImportJob } from "./types";

const M = TIMEFRAME_MS["1m"];
// JST 2026-09-26 00:00
const DAY = Date.UTC(2026, 8, 25, 15);

const iso = (ms: number) => new Date(ms).toISOString();
function csv(times: number[], price = 100): string {
	return [
		"日時,始値,高値,安値,終値,出来高",
		...times.map(
			(t) => `${iso(t)},${price},${price + 10},${price - 10},${price},0.1`,
		),
	].join("\n");
}

async function importCsv(
	t: ReturnType<typeof createTestApp>,
	text: string,
	timeframe = "1m",
): Promise<ImportJob> {
	const form = new FormData();
	form.set("file", new File([text], "a.csv"));
	form.set("timeframe", timeframe);
	const res = await t.app.request("/api/data/imports", {
		method: "POST",
		body: form,
	});
	expect(res.status).toBe(202);
	const { job } = (await res.json()) as { job: ImportJob };
	await t.marketData.running();
	return t.marketData.getImport(job.id) as ImportJob;
}

/** 取り込みを始め、終わるか確認待ちになるまで待つ */
async function startImport(
	t: ReturnType<typeof createTestApp>,
	text: string,
	timeframe = "1m",
): Promise<ImportJob> {
	const form = new FormData();
	form.set("file", new File([text], "a.csv"));
	form.set("timeframe", timeframe);
	const res = await t.app.request("/api/data/imports", {
		method: "POST",
		body: form,
	});
	const { job } = (await res.json()) as { job: ImportJob };
	for (;;) {
		const j = t.marketData.getImport(job.id) as ImportJob;
		if (j.status !== "running" || j.phase === "confirming") return j;
		await new Promise((r) => setTimeout(r, 1));
	}
}

async function resolve(
	t: ReturnType<typeof createTestApp>,
	id: number,
	overwrite: boolean,
): Promise<ImportJob> {
	const res = await t.app.request(`/api/data/imports/${id}/resolve`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ overwrite }),
	});
	expect(res.status).toBe(200);
	const { job } = (await res.json()) as { job: ImportJob };
	// 応答の時点で確認待ちを抜けている
	expect(job).toMatchObject({ phase: "saving", overwrite });
	await t.marketData.running();
	return t.marketData.getImport(id) as ImportJob;
}

const count = (t: ReturnType<typeof createTestApp>, tf: string) =>
	(
		t.db.$client
			.query<{ n: number }, [string]>(
				"select count(*) as n from candles where timeframe = ?",
			)
			.get(tf) as { n: number }
	).n;

describe("過去データの取り込み", () => {
	test("正しい CSV を取り込むと足が保存され、粗い粒度の足も作られる", async () => {
		const t = createTestApp();
		const times = Array.from({ length: 10 }, (_, i) => DAY + i * M);
		const job = await importCsv(t, csv(times));
		expect(job).toMatchObject({
			status: "done",
			insertedRows: 10,
			skippedRows: 0,
			firstTime: DAY,
			lastTime: DAY + 9 * M,
		});
		expect(count(t, "1m")).toBe(10);
		expect(count(t, "5m")).toBe(2);
		expect(count(t, "1d")).toBe(1);
		const day = t.marketDataRepo.loadCandles(
			"1d",
			DAY,
			DAY + TIMEFRAME_MS["1d"],
		);
		expect(day[0]).toMatchObject({
			time: DAY,
			open: 100,
			high: 110,
			low: 90,
			volume: 100_000_000,
		});
	});

	test("不正な行があると何も保存されず、行番号付きのエラーが返る", async () => {
		const t = createTestApp();
		const text = `${csv([DAY])}\n2026-09-26 00:01:00,1,1,1,1,0`;
		const job = await importCsv(t, text);
		expect(job.status).toBe("failed");
		expect(job.errors).toEqual([
			{
				line: 3,
				content: "2026-09-26 00:01:00,1,1,1,1,0",
				message: "日時が読めない（タイムゾーンの無い日時は受け付けない）",
			},
		]);
		expect(count(t, "1m")).toBe(0);
		// 取り込みの一覧にも失敗として残る
		const list = (await (await t.app.request("/api/data/imports")).json()) as {
			imports: ImportJob[];
		};
		expect(list.imports[0]?.status).toBe("failed");
		expect(list.imports[0]?.errors).toHaveLength(1);
	});

	test("既存の足と重なる CSV は、保存の前に重なる期間と件数を返して選択を待つ", async () => {
		const t = createTestApp();
		await importCsv(t, csv([DAY, DAY + M], 100));
		const job = await startImport(t, csv([DAY - M, DAY, DAY + M], 200));
		expect(job).toMatchObject({
			status: "running",
			phase: "confirming",
			overlap: { from: DAY, to: DAY + M, count: 2 },
		});
		// 選ぶまでは何も保存しない
		expect(count(t, "1m")).toBe(2);
	});

	test("「上書きしない」なら重なる足は読み飛ばし、残りを保存する", async () => {
		const t = createTestApp();
		await importCsv(t, csv([DAY, DAY + M], 100));
		const job = await startImport(t, csv([DAY - M, DAY, DAY + M], 200));
		const done = await resolve(t, job.id, false);
		expect(done).toMatchObject({
			status: "done",
			overwrite: false,
			insertedRows: 1,
			skippedRows: 2,
		});
		const closes = t.marketDataRepo
			.loadCandles("1m", DAY - M, DAY + 2 * M)
			.map((c) => c.close);
		expect(closes).toEqual([200, 100, 100]);
	});

	test("「上書きする」なら既存の足を置き換え、そこから作る粗い足も作り直す", async () => {
		const t = createTestApp();
		await importCsv(t, csv([DAY, DAY + M], 100));
		const job = await startImport(t, csv([DAY, DAY + M], 200));
		const done = await resolve(t, job.id, true);
		expect(done).toMatchObject({ status: "done", insertedRows: 2 });
		expect(
			t.marketDataRepo.loadCandles("1m", DAY, DAY + 2 * M).map((c) => c.close),
		).toEqual([200, 200]);
		expect(t.marketDataRepo.loadCandles("5m", DAY, DAY + M)[0]?.close).toBe(
			200,
		);
	});

	test("選ぶ前に中止すると何も保存しない", async () => {
		const t = createTestApp();
		await importCsv(t, csv([DAY], 100));
		const job = await startImport(t, csv([DAY, DAY + M], 200));
		await t.app.request(`/api/data/imports/${job.id}/cancel`, {
			method: "POST",
		});
		await t.marketData.running();
		expect(t.marketData.getImport(job.id)?.status).toBe("canceled");
		expect(
			t.marketDataRepo.loadCandles("1m", DAY, DAY + 2 * M).map((c) => c.close),
		).toEqual([100]);
	});

	test("収集した足と重なるときも確認を待つ", async () => {
		const t = createTestApp();
		t.marketDataRepo.upsertCollected([
			{ time: DAY, open: 1, high: 1, low: 1, close: 1, volume: 0 },
		]);
		const job = await startImport(t, csv([DAY]));
		expect(job.overlap).toEqual({ from: DAY, to: DAY, count: 1 });
	});

	test("確認を待っていない取り込みへの回答は 409", async () => {
		const t = createTestApp();
		const job = await importCsv(t, csv([DAY]));
		const res = await t.app.request(`/api/data/imports/${job.id}/resolve`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ overwrite: true }),
		});
		expect(res.status).toBe(409);
	});

	test("日足を取り込んだ後に同じ期間の1分足を取り込んでも、取り込んだ日足は上書きされない", async () => {
		const t = createTestApp();
		await importCsv(t, csv([DAY], 500), "1d");
		await importCsv(t, csv([DAY, DAY + M], 100));
		const [day] = t.marketDataRepo.loadCandles("1d", DAY, DAY + 1);
		expect(day?.open).toBe(500);
		// 日足の無い粒度は1分足から作られる
		expect(count(t, "1h")).toBe(1);
	});

	test("1分足の後に日足を取り込むと、自動で作った日足を取り込んだ日足で置き換える", async () => {
		const t = createTestApp();
		await importCsv(t, csv([DAY], 100));
		const job = await importCsv(t, csv([DAY], 500), "1d");
		expect(job.insertedRows).toBe(1);
		const [day] = t.marketDataRepo.loadCandles("1d", DAY, DAY + 1);
		expect(day?.open).toBe(500);
	});

	test("欠損を含むデータで欠損期間が返る", async () => {
		const t = createTestApp();
		await importCsv(t, csv([DAY, DAY + M, DAY + 5 * M]));
		const res = await t.app.request("/api/data/coverage");
		const { timeframes } = (await res.json()) as {
			timeframes: { timeframe: string; gaps: unknown[]; count: number }[];
		};
		const m1 = timeframes.find((x) => x.timeframe === "1m");
		expect(m1?.count).toBe(3);
		expect(m1?.gaps).toEqual([
			{ from: DAY + 2 * M, to: DAY + 5 * M, missing: 3 },
		]);
	});

	test("取り込み中に2件目は受け付けない。中止すると何も残らない", async () => {
		const t = createTestApp();
		const times = Array.from({ length: 12_000 }, (_, i) => DAY + i * M);
		const form = () => {
			const f = new FormData();
			f.set("file", new File([csv(times)], "a.csv"));
			f.set("timeframe", "1m");
			return f;
		};
		const first = (await (
			await t.app.request("/api/data/imports", { method: "POST", body: form() })
		).json()) as { job: ImportJob };
		const busy = await t.app.request("/api/data/imports", {
			method: "POST",
			body: form(),
		});
		expect(busy.status).toBe(409);
		const cancel = await t.app.request(
			`/api/data/imports/${first.job.id}/cancel`,
			{
				method: "POST",
			},
		);
		expect(cancel.status).toBe(200);
		await t.marketData.running();
		expect(t.marketData.getImport(first.job.id)?.status).toBe("canceled");
		expect(count(t, "1m")).toBe(0);
	});

	test("粒度が無ければ 400", async () => {
		const t = createTestApp();
		const f = new FormData();
		f.set("file", new File(["x"], "a.csv"));
		const res = await t.app.request("/api/data/imports", {
			method: "POST",
			body: f,
		});
		expect(res.status).toBe(400);
	});

	test("サーバーが途中で止まった取り込みは失敗として残す", () => {
		const t = createTestApp();
		const id = t.marketDataRepo.createImport("1m", "a.csv", 0);
		expect(t.marketDataRepo.failInterrupted(5)).toBe(1);
		expect(t.marketDataRepo.getImport(id)).toMatchObject({
			status: "failed",
			finishedAt: 5,
			message: "サーバーが途中で止まったため中断した",
		});
	});
});

test("期間のバックテストで使える粒度を返す", async () => {
	const t = createTestApp();
	const times = Array.from({ length: 10 }, (_, i) => DAY + i * M);
	await importCsv(t, csv(times));
	const res = await t.app.request(
		`/api/data/usable-timeframes?from=${DAY}&to=${DAY + 10 * M}`,
	);
	expect(await res.json()).toEqual({ timeframes: ["1m"] });
	const empty = await t.app.request(
		`/api/data/usable-timeframes?from=0&to=${DAY}`,
	);
	expect(await empty.json()).toEqual({ timeframes: [] });
	expect(
		(await t.app.request("/api/data/usable-timeframes?from=a&to=1")).status,
	).toBe(400);
});
