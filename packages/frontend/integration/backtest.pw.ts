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
	await expect(page.getByText(/灰色の破線はしきい値/)).toBeVisible();
});

test("RSI と DVOL を両方出して RSI の本数を変えても、小窓は2つのまま", async ({
	page,
	api,
}) => {
	const { runs, chart } = result();
	onResults(api, runs, chart);
	api.on(routes.api.dvol.bars, "$get", (req) => {
		const bars = [];
		for (
			let t = Number(req.query.get("from"));
			t < Number(req.query.get("to"));
			t += 3_600_000
		) {
			bars.push({ time: t, open: 5500, high: 5600, low: 5400, close: 5523 });
		}
		return { bars };
	});
	await page.goto("/backtest/runs/7");
	await openChartValues(page);
	await openChartSettings(page);
	await page.getByLabel("足の粒度").selectOption("1h");
	await page.getByRole("button", { name: "DVOL", exact: true }).click();
	const rsi = page.getByRole("button", { name: "RSI", exact: true });
	if ((await rsi.getAttribute("aria-pressed")) !== "true") await rsi.click();
	// 描画ライブラリは区画ごと（と区画の間の線・時間軸）に表の行を作る
	const rows = page
		.locator("table")
		.filter({ has: page.locator("canvas") })
		.locator("tr");
	// 価格・線・RSI・線・DVOL・時間軸
	await expect(rows).toHaveCount(6);
	await page.getByLabel("RSI の本数").fill("21");
	await expect(page.getByTestId("chart-rsi-21")).toHaveCount(1);
	await expect(rows).toHaveCount(6);
	await expect(page.getByTestId("chart-dvol")).toHaveText("DVOL 55.2");
	await page.getByRole("button", { name: "DVOL", exact: true }).click();
	await expect(rows).toHaveCount(4);
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

test("戦略で DVOL の平均との比を使っていれば、DVOL の小窓と平均を最初から出し、値は戦略の日数", async ({
	page,
	api,
}) => {
	const { runs, chart } = result({
		params: params([
			{ type: "dvolAverage", days: 14, percent: 110, direction: "below" },
		]),
	});
	onResults(api, runs, chart);
	api.on(routes.api.dvol.bars, "$get", (req) => {
		// 頼まれた日数ごとに違う平均を返し、戦略の日数で頼んだことを表示で確かめる
		const days = Number(req.query.get("averageDays"));
		const bars = [];
		for (
			let t = Number(req.query.get("from"));
			t < Number(req.query.get("to"));
			t += 3_600_000
		) {
			bars.push({
				time: t,
				open: 5500,
				high: 5600,
				low: 5400,
				close: 5523,
				average: days === 14 ? 5021 : 9999,
			});
		}
		return { bars };
	});
	await page.goto("/backtest/runs/7");
	await openChartValues(page);
	await expect(page.getByTestId("chart-dvol")).toHaveText("DVOL 55.2");
	await expect(page.getByTestId("chart-dvol-average")).toHaveText(
		"平均14日 50.2（110%）",
	);
	await openChartSettings(page);
	await expect(
		page.getByRole("button", { name: "DVOL の平均" }),
	).toHaveAttribute("aria-pressed", "true");
	await expect(
		page.getByRole("textbox", { name: "DVOL の平均に対する下の %" }),
	).toHaveValue("110");
	await expect(
		page.getByRole("textbox", { name: "DVOL の平均に対する上の %" }),
	).toHaveValue("150");
});
