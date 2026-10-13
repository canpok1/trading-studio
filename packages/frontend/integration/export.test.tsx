import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { changeValue, setupDom } from "../src/shared/lib/test-setup";
import { createFakeApi, routes } from "./fake-api";
import { backtestRun, coverage } from "./fixtures";
import { renderApp } from "./render-app";

setupDom();

// ファイルの保存はブラウザの機能なので、保存を頼まれたファイル（名前と中身）を受け取るところで差し替える
let saved: { name: string; blob: Blob }[] = [];
let restore = () => {};
beforeEach(() => {
	saved = [];
	const blobs = new Map<string, Blob>();
	const createObjectURL = URL.createObjectURL;
	const click = HTMLAnchorElement.prototype.click;
	URL.createObjectURL = (blob: Blob) => {
		const url = `blob:fake/${blobs.size}`;
		blobs.set(url, blob);
		return url;
	};
	HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
		const blob = blobs.get(this.href);
		if (blob) saved.push({ name: this.download, blob });
	};
	restore = () => {
		URL.createObjectURL = createObjectURL;
		HTMLAnchorElement.prototype.click = click;
	};
});
afterEach(async () => {
	await new Promise((r) => setTimeout(r, 20));
	cleanup();
	restore();
});

test("インポートの画面には書き出しを置かず、取り込み済みの説明からエクスポートの画面へ移れる", async () => {
	const api = createFakeApi()
		.on(routes.api.data.coverage, "$get", () => ({ timeframes: [] }))
		.on(routes.api.data.imports, "$get", () => ({ imports: [] }))
		.on(routes.api.segments, "$get", () => ({ segments: [] }));
	const view = renderApp("/data", api);
	expect(view.queryByRole("button", { name: /CSV で書き出す/ })).toBeNull();
	fireEvent.click(view.getByRole("button", { name: "取り込み済みの説明" }));
	const note = view.getByRole("note", { name: "取り込み済みの説明" });
	fireEvent.click(within(note).getByRole("link", { name: "エクスポート" }));
	expect(
		view.getByRole("heading", { level: 1, name: "エクスポート" }),
	).toBeTruthy();
	expect(view.location.current).toBe("/export");
});

// JST 2026-04-01 00:00
const DAY = Date.UTC(2026, 2, 31, 15);
const M = 60_000;

/** 2026-04-01 の1分足と1時間足が保存済みのエクスポート画面の偽物 */
function exportApi() {
	return createFakeApi()
		.on(routes.api.data.coverage, "$get", () => ({
			timeframes: [
				coverage({
					timeframe: "1m",
					count: 30,
					firstTime: DAY,
					lastTime: DAY + 29 * M,
				}),
				coverage({ timeframe: "1h", count: 1, firstTime: DAY, lastTime: DAY }),
			],
		}))
		.on(routes.api.export.backtests, "$get", () => ({ runs: [] }));
}

describe("価格データ（CSV）", () => {
	test("選んだ粒度と期間の足を頼み、応答のファイル名で保存する", async () => {
		const csv = "日時,始値,高値,安値,終値,出来高\n";
		const api = exportApi().on(
			routes.api.data.export,
			"$get",
			() =>
				new Response(csv, {
					headers: {
						"content-type": "text/csv; charset=utf-8",
						"content-disposition":
							'attachment; filename="btcjpy-1h-20260401-20260402.csv"',
					},
				}),
		);
		const view = renderApp("/export", api);
		const card = within(
			await view.findByRole("region", { name: "価格データ（CSV）" }),
		);
		fireEvent.click(await card.findByRole("radio", { name: "1時間" }));
		changeValue(card.getByLabelText("終了"), "2026-04-02");
		fireEvent.click(
			card.getByRole("button", { name: "1時間足を CSV で書き出す" }),
		);

		await waitFor(() => expect(saved).toHaveLength(1));
		expect(saved[0]?.name).toBe("btcjpy-1h-20260401-20260402.csv");
		expect(await saved[0]?.blob.text()).toBe(csv);
		// 期間は開始日の 0:00 から終了日の翌日の 0:00 まで（JST）
		const req = api.requests.find((r) => r.path === "/api/data/export");
		expect(Object.fromEntries(req?.query ?? [])).toEqual({
			timeframe: "1h",
			from: String(DAY),
			to: String(DAY + 2 * 86_400_000),
		});
	});

	test("終了日が開始日より前なら書き出せない", async () => {
		const view = renderApp("/export", exportApi());
		const card = within(
			await view.findByRole("region", { name: "価格データ（CSV）" }),
		);
		// 保存済みの足は 2026-04-01 だけなので、終了日の既定は 2026-04-01
		changeValue(await card.findByLabelText("開始"), "2026-04-02");
		expect(card.getByRole("alert").textContent).toBe(
			"終了日は開始日以降にする",
		);
		expect(
			(
				card.getByRole("button", {
					name: "1分足を CSV で書き出す",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});
});

describe("分析用（ZIP）", () => {
	test("期間内のバックテストを選んで入れ、応答のファイル名で保存する", async () => {
		const api = createFakeApi()
			.on(routes.api.data.coverage, "$get", () => ({ timeframes: [] }))
			.on(routes.api.export.backtests, "$get", () => ({
				runs: [
					backtestRun({ id: 3, name: "上昇を追う" }),
					backtestRun({ id: 5, name: "押し目を拾う" }),
				],
			}))
			.on(
				routes.api.export.analysis,
				"$get",
				() =>
					new Response("PK", {
						headers: {
							"content-type": "application/zip",
							"content-disposition":
								'attachment; filename="trading-studio-analysis-20260901-20260930.zip"',
						},
					}),
			);
		const view = renderApp("/export", api);
		const card = within(view.getByRole("region", { name: "分析用（ZIP）" }));
		const count = card.getByTestId("export-backtests");
		await waitFor(() =>
			expect(count.textContent).toContain("0 件（期間内 2 件）"),
		);
		fireEvent.click(card.getByRole("button", { name: "選ぶ" }));
		const modal = within(
			view.getByRole("dialog", { name: "入れるバックテストを選ぶ" }),
		);
		fireEvent.click(modal.getByRole("button", { name: "すべて選ぶ" }));
		fireEvent.click(modal.getByRole("button", { name: "2 件で決定" }));
		expect(
			view.queryByRole("dialog", { name: "入れるバックテストを選ぶ" }),
		).toBeNull();
		expect(count.textContent).toContain("2 件（期間内 2 件）");

		fireEvent.click(
			card.getByRole("button", { name: "分析用 ZIP を書き出す" }),
		);
		await waitFor(() => expect(saved).toHaveLength(1));
		expect(saved[0]?.name).toBe(
			"trading-studio-analysis-20260901-20260930.zip",
		);
		const req = api.requests.find((r) => r.path === "/api/export/analysis");
		expect(req?.query.get("backtests")).toBe("3,5");
	});
});
