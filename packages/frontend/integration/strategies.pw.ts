import { strategyTemplate } from "@trading-studio/core";
import { expect, test } from "./browser";
import { routes } from "./fake-api";

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
