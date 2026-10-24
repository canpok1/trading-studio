import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, within } from "@testing-library/react";
import type { ImportJob, TimeframeCoverage } from "@trading-studio/backend";
import { setupDom } from "../src/shared/lib/test-setup";
import { createFakeApi, routes } from "./fake-api";
import { coverage, importJob } from "./fixtures";
import { renderApp } from "./render-app";

setupDom();

afterEach(async () => {
	await new Promise((r) => setTimeout(r, 20));
	cleanup();
});

// 取り込みの進み具合は 500ms ごとに問い合わせるので、待ちを長めにする
const WAIT = { timeout: 3000 };
// JST 2026-02-01 00:00
const DAY = Date.UTC(2026, 0, 31, 15);
const M = 60_000;

/** インポート画面が読む口を、保存済みの足も取り込みも無い状態で答える偽物 */
function dataApi() {
	return createFakeApi()
		.on(routes.api.data.coverage, "$get", () => ({ timeframes: [] }))
		.on(routes.api.data.imports, "$get", () => ({ imports: [] }))
		.on(routes.api.segments, "$get", () => ({ segments: [] }));
}

function chooseFile(view: ReturnType<typeof renderApp>, name: string) {
	const input = view.container.querySelector(
		'input[type="file"]',
	) as HTMLInputElement;
	fireEvent.change(input, {
		target: { files: [new File(["日時,始値,高値,安値,終値,出来高\n"], name)] },
	});
}

describe("CSV の取り込み", () => {
	test("上部で銘柄を切り替えると、その銘柄の取り込み済みを読み、その銘柄として送る", async () => {
		const api = dataApi()
			.on(routes.api.data.coverage, "$get", (req) => ({
				timeframes:
					req.query.get("instrument") === "coincheck:eth_jpy"
						? [
								coverage({
									timeframe: "1d",
									count: 1,
									firstTime: DAY,
									lastTime: DAY,
								}),
							]
						: [],
			}))
			.on(routes.api.data.imports, "$post", (_, reply) =>
				reply(202, { job: importJob({ id: 1, timeframe: "1m" }) }),
			)
			.on(routes.api.data.imports[":id"], "$get", () => ({
				job: importJob({ id: 1, status: "done", phase: null }),
			}));
		const view = renderApp("/data", api);
		await view.findByText("取り込んだデータはまだ無い");
		fireEvent.click(view.getByRole("radio", { name: "ETH" }));
		expect(
			await view.findByRole("img", { name: /^日足: 2026\/02\/01/ }),
		).toBeTruthy();
		expect(view.getByText("ETH/JPY の1分足の CSV ファイルを選ぶ")).toBeTruthy();
		chooseFile(view, "eth.csv");
		await view.findByRole("status", {}, WAIT);
		const sent = api.requests.find(
			(r) => r.method === "POST" && r.path === "/api/data/imports",
		);
		expect(String(sent?.body)).toContain(
			'name="instrument"\r\n\r\ncoincheck:eth_jpy',
		);
		// 進み具合もその銘柄で問い合わせる
		expect(
			api.requests
				.filter((r) => r.path === "/api/data/imports/1")
				.every((r) => r.query.get("instrument") === "coincheck:eth_jpy"),
		).toBe(true);
	});

	test("選んだ粒度で CSV を送り、終わると件数と取り込み済みの期間が出る", async () => {
		const done = importJob({
			id: 1,
			timeframe: "1h",
			status: "done",
			phase: null,
			totalRows: 120,
			insertedRows: 120,
			firstTime: DAY,
			lastTime: DAY + 119 * M,
		});
		let saved: { timeframes: TimeframeCoverage[]; imports: ImportJob[] } = {
			timeframes: [],
			imports: [],
		};
		const api = dataApi()
			.on(routes.api.data.coverage, "$get", () => ({
				timeframes: saved.timeframes,
			}))
			.on(routes.api.data.imports, "$get", () => ({ imports: saved.imports }))
			.on(routes.api.data.imports, "$post", (_, reply) =>
				reply(202, { job: importJob({ id: 1, timeframe: "1h" }) }),
			)
			.on(routes.api.data.imports[":id"], "$get", () => {
				saved = {
					timeframes: [
						coverage({
							timeframe: "1d",
							count: 1,
							firstTime: DAY,
							lastTime: DAY,
						}),
					],
					imports: [done],
				};
				return { job: done };
			});
		const view = renderApp("/data", api);
		await view.findByText("取り込んだデータはまだ無い");
		const upload = within(view.getByRole("region", { name: "CSV の取り込み" }));
		fireEvent.click(upload.getByRole("radio", { name: "1時間" }));
		chooseFile(view, "btc.csv");

		const status = await view.findByRole("status", {}, WAIT);
		expect(status.textContent).toBe("120 行を取り込んだ");
		// 取り込みは送ること自体が振る舞いなので、選んだ粒度とファイルが届いたかを見る
		const sent = api.requests.find(
			(r) => r.method === "POST" && r.path === "/api/data/imports",
		);
		expect(String(sent?.body)).toContain('name="timeframe"\r\n\r\n1h');
		expect(String(sent?.body)).toContain('filename="btc.csv"');

		const history = await view.findByRole("region", {
			name: "取り込みの履歴",
		});
		expect(history.textContent).toContain("2026/02/01〜2026/02/01");
		expect(view.getByRole("img", { name: /^日足: 2026\/02\/01/ })).toBeTruthy();
	});

	test("既存の足と重なると件数を出して選ばせ、上書きしないなら読み飛ばした件数を出す", async () => {
		const overlap = { from: DAY, to: DAY + 9 * M, count: 10 };
		const api = dataApi()
			.on(routes.api.data.imports, "$post", (_, reply) =>
				reply(202, { job: importJob({ id: 2 }) }),
			)
			.on(routes.api.data.imports[":id"], "$get", () => ({
				job: importJob({ id: 2, phase: "confirming", overlap }),
			}))
			.on(routes.api.data.imports[":id"].resolve, "$post", (req) => {
				const { overwrite } = req.body as { overwrite: boolean };
				const done = importJob({
					id: 2,
					status: "done",
					phase: null,
					overlap,
					overwrite,
					insertedRows: overwrite ? 10 : 0,
					skippedRows: overwrite ? 0 : 10,
				});
				api.on(routes.api.data.imports[":id"], "$get", () => ({ job: done }));
				return {
					job: importJob({ ...done, status: "running", phase: "saving" }),
				};
			});
		const view = renderApp("/data", api);
		chooseFile(view, "again.csv");

		const confirm = await view.findByRole(
			"region",
			{ name: "既存の足との重なり" },
			WAIT,
		);
		expect(confirm.textContent).toContain("10 本");
		fireEvent.click(
			within(confirm).getByRole("button", { name: /^上書きしない/ }),
		);
		const status = await view.findByText(/行を取り込んだ/, {}, WAIT);
		expect(status.textContent).toBe(
			"0 行を取り込んだ（同じ日時の 10 行は読み飛ばした）",
		);
		expect(
			api.requests.filter((r) => r.path === "/api/data/imports/2/resolve")[0]
				?.body,
		).toEqual({ overwrite: false });
	});

	test("既存の足と重なるとき、上書きするを選ぶとそれを送る", async () => {
		const overlap = { from: DAY, to: DAY + 9 * M, count: 10 };
		const api = dataApi()
			.on(routes.api.data.imports, "$post", (_, reply) =>
				reply(202, { job: importJob({ id: 3 }) }),
			)
			.on(routes.api.data.imports[":id"], "$get", () => ({
				job: importJob({ id: 3, phase: "confirming", overlap }),
			}))
			.on(routes.api.data.imports[":id"].resolve, "$post", () => {
				const done = importJob({
					id: 3,
					status: "done",
					phase: null,
					overwrite: true,
					insertedRows: 10,
				});
				api.on(routes.api.data.imports[":id"], "$get", () => ({ job: done }));
				return {
					job: importJob({ ...done, status: "running", phase: "saving" }),
				};
			});
		const view = renderApp("/data", api);
		chooseFile(view, "again.csv");
		const confirm = await view.findByRole(
			"region",
			{ name: "既存の足との重なり" },
			WAIT,
		);
		fireEvent.click(
			within(confirm).getByRole("button", { name: "上書きする" }),
		);
		const status = await view.findByText(/行を取り込んだ/, {}, WAIT);
		expect(status.textContent).toBe("10 行を取り込んだ");
		expect(
			api.requests.filter((r) => r.path === "/api/data/imports/3/resolve")[0]
				?.body,
		).toEqual({ overwrite: true });
	});

	test("取り込めなかったときは、ファイル名と原因の行と、選び直す案内が出る", async () => {
		const content = "2026-08-01 05:11:00,1,1,1,1,0";
		const api = dataApi()
			.on(routes.api.data.imports, "$post", (_, reply) =>
				reply(202, { job: importJob({ id: 4, fileName: "broken.csv" }) }),
			)
			.on(routes.api.data.imports[":id"], "$get", () => ({
				job: importJob({
					id: 4,
					fileName: "broken.csv",
					status: "failed",
					phase: null,
					message: "不正な行がある",
					errors: [
						{
							line: 2,
							content,
							message: "日時が読めない（タイムゾーンの無い日時は受け付けない）",
						},
					],
					errorCount: 1,
				}),
			}));
		const view = renderApp("/data", api);
		chooseFile(view, "broken.csv");

		const alert = await view.findByRole("alert", {}, WAIT);
		expect(alert.textContent).toContain("broken.csv");
		expect(alert.textContent).toContain(
			"2 行目: 日時が読めない（タイムゾーンの無い日時は受け付けない）",
		);
		expect(alert.textContent).toContain(content);
		expect(within(alert).getByText("別のファイルを選ぶ")).toBeTruthy();
	});
});

describe("相場データの一覧", () => {
	test("相場で絞ると、その相場の相場データだけを出す", async () => {
		const segment = {
			id: 1,
			from: Date.UTC(2026, 6, 31, 15),
			to: Date.UTC(2026, 8, 30, 15),
			regime: "range" as const,
			returnPpm: 10_000,
			volatilityPpm: 20_000,
			createdAt: Date.UTC(2026, 9, 1),
			firstScoredAt: null,
		};
		const api = dataApi().on(routes.api.segments, "$get", (req) => {
			const regime = req.query.get("regime");
			return {
				segments: regime && regime !== segment.regime ? [] : [segment],
			};
		});
		const view = renderApp("/data", api);
		const list = within(view.getByRole("region", { name: "相場データ" }));
		expect(await list.findByText("2026/08〜09")).toBeTruthy();
		fireEvent.click(list.getByRole("radio", { name: "上昇" }));
		expect(await list.findByText("上昇相場の相場データは無い")).toBeTruthy();
		expect(list.queryByText("2026/08〜09")).toBeNull();
	});
});
