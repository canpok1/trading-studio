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
		for (const name of ["戦略", "インポート", "設定", "その他", "ホーム"]) {
			const link = [...nav.querySelectorAll("a")].find(
				(a) => a.textContent === name,
			);
			fireEvent.click(link as HTMLAnchorElement);
			expect(view.getByRole("heading", { level: 1, name })).toBeTruthy();
		}
	});
});

describe("サイドメニューの折り畳み", () => {
	test("畳むとブラウザに保存され、開き直しても畳んだまま", () => {
		const view = renderAt("/home");
		fireEvent.click(view.getByRole("button", { name: "サイドメニューを畳む" }));
		expect(localStorage.getItem("side-collapsed")).toBe("1");
		// 項目名は読み上げ用に残り、マウスを乗せると出る
		const link = view.getByRole("link", { name: "戦略" });
		expect(link.getAttribute("title")).toBe("戦略");
		cleanup();
		const again = renderAt("/home");
		fireEvent.click(
			again.getByRole("button", { name: "サイドメニューを広げる" }),
		);
		expect(localStorage.getItem("side-collapsed")).toBeNull();
	});
});

describe("設定", () => {
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
