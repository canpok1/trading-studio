import { expect, test } from "./browser";
import { routes } from "./fake-api";
import { coverage, importJob } from "./fixtures";

// JST 2026-02-01 00:00
const DAY = Date.UTC(2026, 0, 31, 15);

test("インポートの画面は、取り込み済みの期間と履歴が並んでも横にはみ出さない", async ({
	page,
	api,
}) => {
	api
		.on(routes.api.data.coverage, "$get", () => ({
			timeframes: [
				coverage({
					timeframe: "1m",
					count: 1_000_000,
					firstTime: DAY,
					lastTime: DAY + 999_999 * 60_000,
				}),
				coverage({
					timeframe: "1d",
					count: 700,
					firstTime: DAY,
					lastTime: DAY + 699 * 86_400_000,
				}),
			],
		}))
		.on(routes.api.data.imports, "$get", () => ({
			imports: [
				importJob({
					id: 1,
					fileName: "とても長いファイル名の取り込み用の CSV ファイル.csv",
					status: "done",
					phase: null,
					insertedRows: 1_000_000,
					firstTime: DAY,
					lastTime: DAY + 999_999 * 60_000,
				}),
			],
		}))
		.on(routes.api.segments, "$get", () => ({ segments: [] }));
	await page.goto("/data");
	await expect(
		page.getByRole("region", { name: "取り込みの履歴" }),
	).toBeVisible();
	const overflow = await page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
});
