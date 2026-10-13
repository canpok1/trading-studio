import "../src/shared/lib/test-setup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, routes } from "./fake-api";
import { marketLatest, tradingRun } from "./fixtures";
import { renderApp } from "./render-app";

// 画面が読み込みの応答を受け取り終えてから片付ける（DOM を外した後に描画が走らないように）
afterEach(async () => {
	await new Promise((r) => setTimeout(r, 20));
	cleanup();
});
beforeEach(() => {
	localStorage.clear();
	document.documentElement.classList.remove("dark");
});

describe("画面遷移", () => {
	test("/ はホームへ移る", () => {
		const view = renderApp("/");
		expect(view.getByRole("heading", { name: "ホーム" })).toBeTruthy();
		expect(view.location.current).toBe("/home");
	});

	test("メニューで各画面へ移れる", () => {
		const view = renderApp("/backtest");
		const nav = view.getByRole("navigation", { name: "メイン" });
		for (const name of [
			"戦略",
			"ニュース",
			"インポート",
			"エクスポート",
			"設定",
			"その他",
			"ホーム",
			"バックテスト",
		]) {
			const link = [...nav.querySelectorAll("a")].find(
				(a) => a.textContent === name,
			);
			fireEvent.click(link as HTMLAnchorElement);
			expect(view.getByRole("heading", { level: 1, name })).toBeTruthy();
		}
	});

	test("「その他」からインポート・エクスポート・設定へ移れる", () => {
		for (const name of ["インポート", "エクスポート", "設定"]) {
			const view = renderApp("/other");
			const main = within(view.getByRole("main"));
			fireEvent.click(main.getByRole("link", { name: new RegExp(`^${name}`) }));
			expect(view.getByRole("heading", { level: 1, name })).toBeTruthy();
			cleanup();
		}
	});

	test("旧名「AI判定」の URL はニュース画面へ移る", () => {
		const view = renderApp("/ai");
		expect(view.location.current).toBe("/news");
		expect(
			view.getByRole("heading", { level: 1, name: "ニュース" }),
		).toBeTruthy();
	});

	test("取引画面の URL はホームへ移り、モードの指定を引き継ぐ", async () => {
		const api = createFakeApi()
			.on(routes.api.market.latest, "$get", () => marketLatest())
			.on(routes.api.strategies, "$get", () => ({ strategies: [] }))
			.on(routes.api.data.coverage, "$get", () => ({ timeframes: [] }))
			.on(routes.api.trading.runs, "$get", () => ({
				runs: [
					tradingRun({ id: 1, name: "リアル", mode: "live" }),
					tradingRun({ id: 2, name: "デモ", mode: "paper" }),
				],
			}));
		const view = renderApp("/trades?mode=paper", api);
		expect(view.location.current).toBe("/home?mode=paper");
		const tab = await view.findByRole("tab", { name: "デモ" });
		expect(tab.getAttribute("aria-selected")).toBe("true");
	});
});

describe("サイドメニューの折り畳み", () => {
	test("畳むとブラウザに保存され、開き直しても畳んだまま", () => {
		const view = renderApp("/home");
		fireEvent.click(view.getByRole("button", { name: "サイドメニューを畳む" }));
		expect(localStorage.getItem("side-collapsed")).toBe("1");
		// 項目名は読み上げ用に残り、マウスを乗せると出る
		const link = view.getByRole("link", { name: "戦略" });
		expect(link.getAttribute("title")).toBe("戦略");
		// 畳んだままでも移動できる
		fireEvent.click(view.getByRole("link", { name: "設定" }));
		expect(view.getByRole("heading", { level: 1, name: "設定" })).toBeTruthy();
		cleanup();
		const again = renderApp("/home");
		fireEvent.click(
			again.getByRole("button", { name: "サイドメニューを広げる" }),
		);
		expect(localStorage.getItem("side-collapsed")).toBeNull();
	});
});

describe("設定", () => {
	test("ダークを選ぶとクラスが付き、ブラウザに保存される", () => {
		const view = renderApp("/settings");
		fireEvent.click(view.getByRole("radio", { name: "ダーク" }));
		expect(document.documentElement.classList.contains("dark")).toBe(true);
		expect(localStorage.getItem("theme")).toBe("dark");
		fireEvent.click(view.getByRole("radio", { name: "ライト" }));
		expect(document.documentElement.classList.contains("dark")).toBe(false);
		fireEvent.click(view.getByRole("radio", { name: "OS に合わせる" }));
		expect(localStorage.getItem("theme")).toBeNull();
	});
});
