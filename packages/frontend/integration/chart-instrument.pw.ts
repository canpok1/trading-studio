// チャートの設定で描く銘柄を選ぶ。戦略の候補外の銘柄はチャートだけを替え、印を描かない
import { ETH_JPY, XRP_JPY } from "@trading-studio/core";
import { expect, test } from "./browser";
import { openChartSettings } from "./chart-settings";
import { templateStrategy, tradingRun } from "./fixtures";
import { multiInstrumentRun, onHome } from "./home-api";

const PRICES = { [ETH_JPY.id]: 520_000, [XRP_JPY.id]: 210_000 };

test.beforeEach(async ({ page }) => {
	// 札が最も長くなる粒度で、スマホ幅でも1行に収まるかを見る
	await page.addInitScript(() => localStorage.setItem("chart-timeframe", "4h"));
});

test("候補外の銘柄を選ぶとチャートだけその銘柄になり、札と候補外の旨を出し、戻せる", async ({
	page,
	api,
}) => {
	onHome(api, { strategies: [templateStrategy(1, "BTC")], prices: PRICES });
	await page.goto("/strategies/1");
	const tag = page.getByTestId("chart-instrument");
	await expect(tag).toHaveText("BTC");
	await expect(page.getByTestId("chart-close")).toHaveText("10,000,000円");

	await openChartSettings(page);
	const dialog = page.getByRole("dialog", { name: "チャートの設定" });
	await expect(dialog).toContainText("戦略の銘柄は BTC");
	await dialog.getByRole("button", { name: "XRP" }).click();
	await page.keyboard.press("Escape");
	await expect(tag).toHaveText("XRP");
	await expect(page.getByTestId("chart-close")).toHaveText("210.000円");
	await expect(page.getByText("XRP は戦略の候補外のため印なし")).toBeVisible();
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth > window.innerWidth,
	);
	expect(overflow).toBe(false);

	await page.getByRole("button", { name: "戦略の銘柄に戻す" }).click();
	await expect(tag).toHaveText("BTC");
	await expect(page.getByText(/候補外のため印なし/)).toHaveCount(0);

	// 保存しないので、再読み込みすると戦略の銘柄に戻る
	await openChartSettings(page);
	await dialog.getByRole("button", { name: "ETH" }).click();
	await page.keyboard.press("Escape");
	await expect(tag).toHaveText("ETH");
	await page.reload();
	await expect(tag).toHaveText("BTC");
});

test("候補の銘柄を設定で選ぶと見る銘柄の切り替えと同じになる", async ({
	page,
	api,
}) => {
	onHome(api, {
		strategies: [templateStrategy(1, "3銘柄")],
		runs: [
			multiInstrumentRun({
				id: 1,
				name: "3銘柄",
				enabled: true,
			}),
		],
		prices: PRICES,
	});
	await page.goto("/strategies/1");
	const picker = page.getByRole("group", { name: "見る銘柄" });
	await expect(
		picker.getByRole("radio", { name: "ETH・保有中" }),
	).toBeChecked();
	await openChartSettings(page);
	await page
		.getByRole("dialog", { name: "チャートの設定" })
		.getByRole("button", { name: "BTC" })
		.click();
	await page.keyboard.press("Escape");
	await expect(picker.getByRole("radio", { name: "BTC" })).toBeChecked();
	await expect(page.getByTestId("chart-instrument")).toHaveText("BTC");
	await expect(page.getByText(/候補外のため印なし/)).toHaveCount(0);
});

test("ホームでも候補外の銘柄を選べ、カードを替えると戦略の銘柄に戻る", async ({
	page,
	api,
}) => {
	onHome(api, {
		strategies: [templateStrategy(1, "BTC1"), templateStrategy(2, "BTC2")],
		runs: [
			tradingRun({ id: 1, name: "BTC1", enabled: true }),
			tradingRun({ id: 2, name: "BTC2", enabled: true }),
		],
		prices: PRICES,
	});
	await page.goto("/home");
	const tag = page.getByTestId("chart-instrument");
	await expect(tag).toHaveText("BTC");
	await openChartSettings(page);
	await page
		.getByRole("dialog", { name: "チャートの設定" })
		.getByRole("button", { name: "ETH" })
		.click();
	await page.keyboard.press("Escape");
	await expect(tag).toHaveText("ETH");
	await expect(page.getByTestId("chart-close")).toHaveText("520,000円");
	await expect(page.getByText("ETH は戦略の候補外のため印なし")).toBeVisible();
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth > window.innerWidth,
	);
	expect(overflow).toBe(false);

	const cards = page.getByTestId("home-strategy");
	await cards.nth(1).getByRole("button").first().click();
	await expect(tag).toHaveText("BTC");
	await cards.nth(0).getByRole("button").first().click();
	await expect(tag).toHaveText("BTC");
});
