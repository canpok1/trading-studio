import { afterEach, describe, expect, test } from "bun:test";
import { cleanup } from "@testing-library/react";
import { setupDom } from "../src/shared/lib/test-setup";
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

describe("稼働中の戦略", () => {
	test("自動取引で稼働中のタブが使う戦略は、条件を変えられず削除もできない", async () => {
		const api = createFakeApi();
		onHome(api, {
			strategies: [templateStrategy(1, "稼働中")],
			runs: [
				tradingRun({
					id: 1,
					name: "デモ",
					enabled: true,
					strategy: { id: 1, name: "稼働中" },
					strategyLock: "running",
				}),
			],
		});
		const view = renderApp("/strategies/1", api);
		expect(
			await view.findByText(
				/この戦略を使うタブが自動取引で稼働中のため、条件を変えられない。/,
			),
		).toBeTruthy();
		expect(view.queryByRole("button", { name: "この戦略を削除" })).toBeNull();
		const quantity = view.getByLabelText("1回の注文量（BTC）");
		// happy-dom は無効にした fieldset の中の入力を :disabled にしないので、囲む fieldset で見る
		expect(quantity.closest("fieldset:disabled")).not.toBeNull();
	});
});
