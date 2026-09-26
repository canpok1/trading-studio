import "./test-setup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { App } from "./App";
import { ApiProvider, createApiClient } from "./api";

afterEach(cleanup);
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
	test("/ はバックテストへ移る", () => {
		const view = renderAt("/");
		expect(view.getByRole("heading", { name: "バックテスト" })).toBeTruthy();
	});

	test("タブで各画面へ移れる", () => {
		const view = renderAt("/backtest");
		const nav = view.getByRole("navigation", { name: "メイン" });
		for (const name of ["戦略設定", "過去データ", "その他"]) {
			const link = [...nav.querySelectorAll("a")].find(
				(a) => a.textContent === name,
			);
			fireEvent.click(link as HTMLAnchorElement);
			expect(view.getByRole("heading", { level: 1, name })).toBeTruthy();
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
