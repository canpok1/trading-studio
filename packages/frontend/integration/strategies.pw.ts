import type { Locator } from "@playwright/test";
import { strategyTemplate } from "@trading-studio/core";
import { expect, test } from "./browser";
import { routes } from "./fake-api";
import { tradingRun } from "./fixtures";
import { onHome } from "./home-api";

test("戦略の編集画面は横にはみ出さない", async ({ page, api }) => {
	const strategy = {
		id: 1,
		name: "トレンド",
		params: strategyTemplate("trend").params,
		createdAt: 0,
		updatedAt: 0,
	};
	api
		.on(routes.api.strategies, "$get", () => ({ strategies: [strategy] }))
		.on(routes.api.data.latest, "$get", () => ({ latest: null }));
	await page.goto("/strategies/1/edit");
	await expect(
		page.getByRole("heading", { name: "「トレンド」の編集" }),
	).toBeVisible();
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - window.innerWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
});

test("戦略の一覧は長い名前を折り返し、2行目に状態・モード・通算をこの順に並べる", async ({
	page,
	api,
}) => {
	const name =
		"とても長い名前の戦略で一覧の幅に収まらないことを確かめるためのもの_LongStrategyNameWithoutSpaces";
	onHome(api, { runs: [tradingRun({ id: 1, name, enabled: true })] });
	await page.goto("/strategies");
	const row = page.getByRole("list", { name: "戦略の一覧" }).getByRole("link");
	const title = row.getByText(name, { exact: true });
	await expect(title).toBeVisible();
	// 見切れていない（折り返しで全文が枠に収まる）
	expect(
		await title.evaluate((el) => el.scrollWidth - el.clientWidth),
	).toBeLessThanOrEqual(0);
	const box = async (l: Locator) => {
		const b = await l.boundingBox();
		if (!b) throw new Error("位置が取れない");
		return b;
	};
	const titleBox = await box(title);
	const state = await box(row.getByTestId("strategy-state"));
	const mode = await box(row.getByText("デモ", { exact: true }));
	const pnl = await box(row.getByText(/^通算/));
	expect(state.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
	expect(state.x).toBeLessThan(mode.x);
	expect(mode.x).toBeLessThan(pnl.x);
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - window.innerWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
});
