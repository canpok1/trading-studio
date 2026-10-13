import { expect, test } from "./browser";
import { routes } from "./fake-api";
import { backtestRun, coverage } from "./fixtures";

// JST 2026-04-01 00:00
const DAY = Date.UTC(2026, 2, 31, 15);
const M = 60_000;

test.beforeEach(({ api }) => {
	api
		.on(routes.api.data.coverage, "$get", () => ({
			timeframes: [
				coverage({
					timeframe: "1m",
					count: 30,
					firstTime: DAY,
					lastTime: DAY + 29 * M,
				}),
				coverage({ timeframe: "1h", count: 1, firstTime: DAY, lastTime: DAY }),
			],
		}))
		.on(routes.api.export.backtests, "$get", () => ({
			runs: [
				backtestRun({ id: 1, name: "とても長い名前のバックテストの実行" }),
			],
		}));
});

test("エクスポートの画面は横にはみ出さない", async ({ page }) => {
	await page.goto("/export");
	await expect(
		page.getByRole("button", { name: "1分足を CSV で書き出す" }),
	).toBeVisible();
	const overflow = await page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
});
