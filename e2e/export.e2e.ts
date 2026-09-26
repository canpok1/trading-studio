import { expect, test } from "@playwright/test";

function csv(startMs: number, rows: number): string {
	const lines = ["日時,始値,高値,安値,終値,出来高"];
	for (let i = 0; i < rows; i++) {
		const t = new Date(startMs + i * 60_000).toISOString();
		lines.push(`${t},13000000,13010000,12990000,13000000,0.5`);
	}
	return lines.join("\n");
}

test("保存済みの足を期間を選んで CSV で書き出せる", async ({ page }, info) => {
	const day =
		info.project.name === "mobile"
			? Date.UTC(2026, 3, 1)
			: Date.UTC(2026, 3, 15);
	await page.goto("/data");
	await page
		.getByRole("region", { name: "CSV の取り込み" })
		.getByText("1分", { exact: true })
		.click();
	await page.locator('input[type="file"]').setInputFiles({
		name: "export.csv",
		mimeType: "text/csv",
		buffer: Buffer.from(csv(day, 30)),
	});
	await expect(
		page.getByRole("status").filter({ hasText: "30 行を取り込んだ" }),
	).toBeVisible();

	// 過去データの画面には書き出しを置かず、エクスポートの画面へ案内する
	await expect(
		page.getByRole("button", { name: /CSV で書き出す/ }),
	).toHaveCount(0);
	await page
		.getByRole("link", { name: "エクスポート", exact: true })
		.last()
		.click();
	await expect(
		page.getByRole("heading", { level: 1, name: "エクスポート" }),
	).toBeVisible();

	const jst = new Date(day + 9 * 3600_000).toISOString().slice(0, 10);
	const csvCard = page.getByRole("region", { name: "価格データ（CSV）" });
	await csvCard.getByText("1分", { exact: true }).click();
	await csvCard.getByLabel("開始").fill(jst);
	await csvCard.getByLabel("終了").fill(jst);
	const download = page.waitForEvent("download");
	await csvCard.getByRole("button", { name: "1分足を CSV で書き出す" }).click();
	const file = await download;
	const ymd = jst.replaceAll("-", "");
	expect(file.suggestedFilename()).toBe(`btcjpy-1m-${ymd}-${ymd}.csv`);
	const text = (await (await file.createReadStream()).toArray()).join("");
	const lines = text.trimEnd().split("\n");
	expect(lines[0]).toBe("日時,始値,高値,安値,終値,出来高");
	expect(lines).toHaveLength(31);
	expect(lines[1]).toBe(
		`${jst}T09:00:00.000+09:00,13000000,13010000,12990000,13000000,0.5`,
	);
});

test("期間を選んで分析用の ZIP を書き出せる", async ({ page }) => {
	await page.goto("/export");
	const card = page.getByRole("region", { name: "分析用（ZIP）" });
	// 他のテストで実行したバックテストが一覧に出ていれば、1つ選んで入れる
	const runs = card.getByRole("checkbox");
	await expect(
		runs.first().or(card.getByText("期間内に実行したものは無い")),
	).toBeVisible();
	if ((await runs.count()) > 0) await runs.first().check();
	const download = page.waitForEvent("download");
	await card.getByRole("button", { name: "分析用 ZIP を書き出す" }).click();
	const file = await download;
	expect(file.suggestedFilename()).toMatch(
		/^trading-studio-analysis-\d{8}-\d{8}\.zip$/,
	);
	const buf = Buffer.concat(await (await file.createReadStream()).toArray());
	// ZIP の先頭のシグネチャと、中の README
	expect(buf.readUInt32LE(0)).toBe(0x04034b50);
	expect(buf.includes(Buffer.from("README.md"))).toBe(true);
});

test("エクスポートの画面は横にはみ出さない", async ({ page }) => {
	await page.goto("/export");
	await expect(
		page.getByRole("button", { name: "分析用 ZIP を書き出す" }),
	).toBeVisible();
	const overflow = await page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
});
