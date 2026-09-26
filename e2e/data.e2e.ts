import { expect, test } from "@playwright/test";

function csv(startMs: number, rows: number): string {
	const lines = ["日時,始値,高値,安値,終値,出来高"];
	for (let i = 0; i < rows; i++) {
		const t = new Date(startMs + i * 60_000).toISOString();
		lines.push(`${t},13000000,13010000,12990000,13000000,0.5`);
	}
	return lines.join("\n");
}

test("CSV を選ぶと取り込まれ、一覧に期間が増える", async ({ page }, info) => {
	// スマホ幅と PC 幅で同じ DB を使うので、日付をずらす
	const day =
		info.project.name === "mobile"
			? Date.UTC(2026, 0, 1)
			: Date.UTC(2026, 1, 1);
	await page.goto("/data");
	await page.getByText("1分", { exact: true }).click();
	await page.locator('input[type="file"]').setInputFiles({
		name: "btc.csv",
		mimeType: "text/csv",
		buffer: Buffer.from(csv(day, 120)),
	});
	await expect(
		page.getByRole("status").filter({ hasText: "120 行を取り込んだ" }),
	).toBeVisible();
	const history = page.getByRole("region", { name: "取り込みの履歴" });
	const jst = new Date(day + 9 * 3600_000);
	const label = `${jst.getUTCFullYear()}/${String(jst.getUTCMonth() + 1).padStart(2, "0")}/${String(jst.getUTCDate()).padStart(2, "0")}`;
	await expect(history.getByText(`${label}〜${label}`).first()).toBeVisible();
	await expect(page.getByRole("img", { name: /^日足:/ })).toBeVisible();
});

test("不正な CSV ではエラーと原因の行が表示される", async ({ page }) => {
	await page.goto("/data");
	await page.locator('input[type="file"]').setInputFiles({
		name: "broken.csv",
		mimeType: "text/csv",
		buffer: Buffer.from(
			"日時,始値,高値,安値,終値,出来高\n2026-08-01 05:11:00,1,1,1,1,0\n",
		),
	});
	const alert = page.getByRole("alert");
	await expect(alert).toContainText("broken.csv");
	await expect(alert).toContainText("2 行目");
	await expect(alert).toContainText("タイムゾーンの無い日時は受け付けない");
	await expect(alert.getByText("別のファイルを選ぶ")).toBeVisible();
});

test("横にはみ出さない", async ({ page }) => {
	await page.goto("/data");
	await expect(
		page.getByRole("heading", { name: "取り込み済み" }),
	).toBeVisible();
	const overflow = await page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
});
