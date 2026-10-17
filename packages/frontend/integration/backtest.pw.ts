import type { Page } from "@playwright/test";
import type { BacktestRun } from "@trading-studio/backend";
import {
	chartBars,
	onResults,
	onRunPage,
	params,
	resultRun,
	START,
} from "./backtest-fakes";
import { expect, test } from "./browser";
import {
	openChartLegend,
	openChartSettings,
	openChartValues,
} from "./chart-settings";
import { routes } from "./fake-api";
import { storedStrategy } from "./fixtures";

/** 7日分の1時間足のチャートを持つ実行 */
const result = (over: Partial<BacktestRun> = {}) => {
	const run = resultRun({ id: 7, name: "結果", params: params(), ...over });
	return {
		runs: new Map([[run.id, run]]),
		chart: {
			timeframe: "1h" as const,
			bars: chartBars(START + 2 * 24 * 3_600_000, 7 * 24),
			markers: [],
			judgments: null,
		},
	};
};

async function overflow(page: Page) {
	return page.evaluate(
		() => document.documentElement.scrollWidth - window.innerWidth,
	);
}

test("実行の画面は横にはみ出さない", async ({ page, api }) => {
	onRunPage(api, {
		strategies: [storedStrategy({ id: 1, name: "高値抜け", params: params() })],
	});
	await page.goto("/backtest");
	await expect(page.getByLabel("バックテスト名")).toBeVisible();
	expect(await overflow(page)).toBeLessThanOrEqual(0);
});

test("結果の画面にチャートが描かれ、横にはみ出さない", async ({
	page,
	api,
}) => {
	const { runs, chart } = result();
	onResults(api, runs, chart);
	await page.goto("/backtest/runs/7");
	await expect(page.getByRole("img", { name: "価格チャート" })).toBeVisible();
	await openChartSettings(page);
	await expect(
		page.getByRole("button", { name: "ローソク足", exact: true }),
	).toBeEnabled();
	expect(await overflow(page)).toBeLessThanOrEqual(0);
});

test("RSI の条件を持つ戦略の結果では、チャートの下に RSI の小窓と値が出る", async ({
	page,
	api,
}) => {
	const { runs, chart } = result({
		params: params(
			[
				{
					type: "rsi",
					timeframe: "1h",
					period: 14,
					threshold: 30,
					direction: "below",
				},
			],
			{},
			[
				{
					type: "rsi",
					timeframe: "1h",
					period: 14,
					threshold: 70,
					direction: "above",
				},
			],
		),
	});
	onResults(api, runs, chart);
	await page.goto("/backtest/runs/7");
	await openChartValues(page);
	await openChartSettings(page);
	await page.getByLabel("足の粒度").selectOption("1h");
	await expect(
		page.getByRole("button", { name: "RSI", exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("chart-rsi-14")).toHaveText(/^RSI14 \d+\.\d$/);
	await openChartLegend(page);
	await expect(page.getByText(/点線はしきい値/)).toBeVisible();
});

test("ボリンジャーバンドの条件を持つ戦略の結果では、チャートにバンドと値が出る", async ({
	page,
	api,
}) => {
	const { runs, chart } = result({
		params: params([
			{
				type: "bollinger",
				timeframe: "1h",
				period: 20,
				sigma: 2,
				band: "lower",
			},
		]),
	});
	onResults(api, runs, chart);
	await page.goto("/backtest/runs/7");
	await openChartValues(page);
	await openChartSettings(page);
	await page.getByLabel("足の粒度").selectOption("1h");
	await expect(
		page.getByRole("button", { name: "BB", exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("chart-bb")).toHaveText(
		/^BB20 [\d,]+\/[\d,]+\/[\d,]+$/,
	);
	await openChartLegend(page);
	await expect(page.getByText(/本数と σ は戦略の条件の値/)).toBeVisible();
});

test("別の AI で作るとき、資料をサーバーが付けた名前で保存できる", async ({
	page,
	api,
}) => {
	const { runs, chart } = result();
	onResults(api, runs, chart).on(
		routes.api.advice.runs[":id"]["external-prompt"],
		"$get",
		() => ({
			prompt: "指示の本文",
			file: { name: "backtest-7.md", content: "資料" },
			instructionsVersion: 3,
		}),
	);
	await page.goto("/backtest/runs/7");
	await page.getByRole("button", { name: "別の AI で作る" }).click();
	const dialog = page.getByRole("dialog", { name: "別の AI で作る" });
	const download = page.waitForEvent("download");
	await dialog.getByRole("button", { name: "資料をダウンロード" }).click();
	expect((await download).suggestedFilename()).toBe("backtest-7.md");
});
