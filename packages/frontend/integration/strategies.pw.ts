import type { Locator } from "@playwright/test";
import { BTC_JPY, strategyTemplate } from "@trading-studio/core";
import { expect, test } from "./browser";
import { routes } from "./fake-api";
import { storedStrategy, tradingRun } from "./fixtures";
import { onHome } from "./home-api";

test("戦略の編集画面は横にはみ出さない", async ({ page, api }) => {
	const strategy = storedStrategy({
		id: 1,
		name: "トレンド",
		params: strategyTemplate("trend").params,
	});
	api
		.on(routes.api.strategies, "$get", () => ({ strategies: [strategy] }))
		.on(routes.api.data.latest, "$get", () => ({
			instrument: BTC_JPY,
			latest: null,
		}));
	await page.goto("/strategies/1/edit");
	await expect(
		page.getByRole("heading", { name: "「トレンド」の編集" }),
	).toBeVisible();
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - window.innerWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
});

test("候補が3銘柄の戦略の編集画面は、最長の値でも銘柄・順位・注文額の欄が横にはみ出さない", async ({
	page,
	api,
}) => {
	const t = strategyTemplate("trend").params;
	const strategy = storedStrategy({
		id: 1,
		name: "3銘柄",
		instruments: [
			"coincheck:btc_jpy",
			"coincheck:eth_jpy",
			"coincheck:xrp_jpy",
		],
		params: {
			...t,
			buys: t.buys.map((b) => ({ ...b, orderAmount: 100_000_000 })),
			maxHoldings: 10,
			ranking: {
				indicator: "turnover",
				timeframe: "15m",
				period: 200,
				order: "asc",
			},
		},
	});
	api
		.on(routes.api.strategies, "$get", () => ({ strategies: [strategy] }))
		.on(routes.api.data.latest, "$get", () => ({
			instrument: BTC_JPY,
			latest: null,
		}));
	await page.goto("/strategies/1/edit");
	await expect(page.getByLabel("順位の指標")).toHaveValue("turnover");
	await expect(page.getByLabel("1回の買いの金額（円）")).toHaveValue(
		"100,000,000",
	);
	for (const label of ["順位の指標", "順位の本数", "同時に持つ銘柄数"]) {
		const box = await page.getByLabel(label).boundingBox();
		const card = await page
			.getByRole("heading", { name: "銘柄", exact: true })
			.locator("..")
			.boundingBox();
		if (!box || !card) throw new Error("位置が取れない");
		expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width);
	}
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
