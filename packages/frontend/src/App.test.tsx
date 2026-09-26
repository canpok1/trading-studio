import "./test-setup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { App } from "./App";
import { ApiProvider, createApiClient } from "./api";

// 画面が読み込みの応答を受け取り終えてから片付ける（DOM を外した後に描画が走らないように）
afterEach(async () => {
	await new Promise((r) => setTimeout(r, 20));
	cleanup();
});
beforeEach(() => {
	localStorage.clear();
	document.documentElement.classList.remove("dark");
});

// どの API にも空のデータを返す
const client = createApiClient(
	Object.assign(async () => Response.json({ timeframes: [], imports: [] }), {
		preconnect: () => {},
	}),
);

const renderAt = (path: string) =>
	render(
		<ApiProvider client={client}>
			<MemoryRouter initialEntries={[path]}>
				<App />
			</MemoryRouter>
		</ApiProvider>,
	);

describe("画面遷移", () => {
	test("/ はホームへ移る", () => {
		const view = renderAt("/");
		expect(view.getByRole("heading", { name: "ホーム" })).toBeTruthy();
	});

	test("タブで各画面へ移れる", () => {
		const view = renderAt("/backtest");
		const nav = view.getByRole("navigation", { name: "メイン" });
		for (const name of ["戦略設定", "過去データ", "その他", "ホーム"]) {
			const link = [...nav.querySelectorAll("a")].find(
				(a) => a.textContent === name,
			);
			fireEvent.click(link as HTMLAnchorElement);
			// 戻るボタンのある画面は、スマホの上部とPCの見出しの2か所に出す
			expect(
				view.getAllByRole("heading", { level: 1, name }).length,
			).toBeGreaterThan(0);
		}
	});
});

describe("表示設定", () => {
	test("ダークを選ぶとクラスが付き、ブラウザに保存される", () => {
		const view = renderAt("/settings");
		fireEvent.click(view.getByRole("radio", { name: "ダーク" }));
		expect(document.documentElement.classList.contains("dark")).toBe(true);
		expect(localStorage.getItem("theme")).toBe("dark");
		fireEvent.click(view.getByRole("radio", { name: "ライト" }));
		expect(document.documentElement.classList.contains("dark")).toBe(false);
		fireEvent.click(view.getByRole("radio", { name: "OS に合わせる" }));
		expect(localStorage.getItem("theme")).toBeNull();
	});
});
