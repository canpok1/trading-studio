import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { changeValue, setupDom } from "../src/shared/lib/test-setup";
import { createFakeApi } from "./fake-api";
import { templateStrategy, tradingRun } from "./fixtures";
import { onHome } from "./home-api";
import { renderApp } from "./render-app";

setupDom();

// 画面が読み込みの応答を受け取り終えてから片付ける（DOM を外した後に描画が走らないように）
afterEach(async () => {
	await new Promise((r) => setTimeout(r, 20));
	cleanup();
});

describe("戦略の編集画面", () => {
	test("稼働中の戦略は、編集画面を開いても条件を変えられない", async () => {
		const api = createFakeApi();
		onHome(api, {
			strategies: [templateStrategy(1, "稼働中")],
			runs: [
				tradingRun({
					id: 1,
					name: "稼働中",
					enabled: true,
					strategyLock: "running",
				}),
			],
		});
		const view = renderApp("/strategies/1/edit", api);
		expect(
			await view.findByText(/自動取引が稼働中のため、条件を変えられない。/),
		).toBeTruthy();
		const quantity = view.getByLabelText("1回の注文量（BTC）");
		// happy-dom は無効にした fieldset の中の入力を :disabled にしないので、囲む fieldset で見る
		expect(quantity.closest("fieldset:disabled")).not.toBeNull();
	});

	test("動かしたことがあれば保存時に成績をリセットするかを聞き、リセットすると口座を戻す", async () => {
		const api = createFakeApi();
		const run = tradingRun({ id: 1, name: "検証", ranSinceReset: true });
		run.account.cash = 1_050_000;
		run.account.equity = 1_050_000;
		const state = onHome(api, {
			strategies: [templateStrategy(1, "検証")],
			runs: [run],
		});
		const view = renderApp("/strategies/1/edit", api);
		await view.findByRole("heading", { name: "「検証」の編集" });
		await new Promise((r) => setTimeout(r, 0));
		changeValue(view.getByLabelText("1日の損失上限（円）"), "50000");
		fireEvent.click(view.getByRole("button", { name: "保存" }));
		const dialog = within(
			view.getByRole("dialog", { name: "成績をリセットするか" }),
		);
		fireEvent.click(dialog.getByRole("button", { name: "リセットして保存" }));
		await waitFor(() =>
			expect(view.getByRole("status").textContent).toBe(
				"保存し、成績をリセットした",
			),
		);
		expect(state.strategies[0]?.params.dailyLossLimit).toBe(50_000);
		expect(state.runs[0]?.account.cash).toBe(1_000_000);
	});

	test("まだ動かしていなければ聞かずに保存する", async () => {
		const api = createFakeApi();
		onHome(api, {
			strategies: [templateStrategy(1, "新規")],
			runs: [tradingRun({ id: 1, name: "新規" })],
		});
		const view = renderApp("/strategies/1/edit", api);
		await view.findByRole("heading", { name: "「新規」の編集" });
		await new Promise((r) => setTimeout(r, 0));
		changeValue(view.getByLabelText("1日の損失上限（円）"), "50000");
		fireEvent.click(view.getByRole("button", { name: "保存" }));
		await waitFor(() =>
			expect(view.getByRole("status").textContent).toBe("保存した"),
		);
		expect(view.queryByRole("dialog")).toBeNull();
	});
});
