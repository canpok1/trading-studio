// 候補が2つ以上の戦略（ADR 0037）のホームと戦略の画面。チャートは canvas に描くので実ブラウザで確かめる
import { BTC_JPY, ETH_JPY, XRP_JPY } from "@trading-studio/core";
import { expect, test } from "./browser";
import { storedOrder, templateStrategy } from "./fixtures";
import { multiInstrumentRun, onHome } from "./home-api";

/** 長い名前・大きな値でも崩れないかを見るため、名前と損益を最長にする */
const NAME = "トレンド3銘柄".repeat(4);

function setup(api: Parameters<typeof onHome>[0]) {
	return onHome(api, {
		strategies: [templateStrategy(1, NAME)],
		runs: [
			multiInstrumentRun({
				id: 1,
				name: NAME,
				enabled: true,
				strategyLock: "running",
			}),
		],
		prices: { [ETH_JPY.id]: 520_000, [XRP_JPY.id]: 210_000 },
		orders: [
			storedOrder({
				id: "p1",
				instrument: BTC_JPY.id,
				side: "sell",
				pnl: 99_999_999,
			}),
			storedOrder({ id: "p2", instrument: ETH_JPY.id, quantity: 18_000 }),
			storedOrder({ id: "p3", instrument: XRP_JPY.id, quantity: 52_000 }),
		],
	});
}

test("戦略の画面は保有中の先頭の銘柄で開き、銘柄を切り替えると注文もその銘柄になり、全銘柄にも切り替えられる", async ({
	page,
	api,
}) => {
	setup(api);
	await page.goto("/strategies/1");
	const picker = page.getByRole("group", { name: "見る銘柄" });
	await expect(
		picker.getByRole("radio", { name: "ETH・保有中" }),
	).toBeChecked();
	await expect(picker.getByRole("radio", { name: "BTC" })).not.toBeChecked();
	// 含み損益は全銘柄の合計（ETH +3,600円・XRP +5,200円）
	const unrealized = page.getByRole("region", { name: "含み損益（合計）" });
	await expect(unrealized).toContainText("+8,800円");
	await expect(unrealized).toContainText("保有 ETH・XRP");
	const table = page.getByRole("list", { name: "銘柄ごとの成績" });
	await expect(table.getByRole("listitem")).toHaveText([
		/^合計.*99,999,999円.*2銘柄/,
		/^BTC.*99,999,999円/,
		/^ETH.*0\.18 ETH/,
		/^XRP.*520 XRP/,
	]);

	const orders = page.getByRole("region", { name: "注文・約定" });
	await expect(
		orders.getByRole("heading", { name: "注文・約定（ETH）" }),
	).toBeVisible();
	await expect(orders.getByText(/1 件/)).toBeVisible();
	await picker.getByText("XRP・保有中").click();
	await expect(
		orders.getByRole("heading", { name: "注文・約定（XRP）" }),
	).toBeVisible();
	await orders.getByRole("button", { name: "全銘柄" }).click();
	await expect(orders.getByText(/3 件/)).toBeVisible();

	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth > window.innerWidth,
	);
	expect(overflow).toBe(false);
});

test("ホームのカードは次の動きに銘柄を添え、チャートで銘柄を切り替えられる", async ({
	page,
	api,
}) => {
	setup(api);
	await page.goto("/home");
	const card = page.getByTestId("home-strategy");
	// 保有中の銘柄から交互に出す
	await expect(card).toContainText("ETH");
	await expect(card).toContainText("XRP");
	await card.getByRole("button").first().click();
	const picker = page.getByRole("group", { name: "見る銘柄" });
	await expect(
		picker.getByRole("radio", { name: "ETH・保有中" }),
	).toBeChecked();
	await picker.getByText("BTC", { exact: true }).click();
	await expect(page.getByTestId("chart-close")).toHaveText("10,000,000円");
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth > window.innerWidth,
	);
	expect(overflow).toBe(false);
});
