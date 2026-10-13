import { expect, test } from "@playwright/test";

// 他のテストへ影響しないよう、途中で失敗しても既定へ戻す
test.afterEach(async ({ request }) => {
	await request.put("/api/retention", {
		data: { decisionsDays: 90, backtestsDays: null, marketDataYears: 5 },
	});
});

test("設定の「全般」でデータの保持期間を変えられる", async ({ page }, info) => {
	await page.goto("/settings");
	const card = page
		.locator("div", {
			has: page.getByRole("heading", { name: "データの保持" }),
		})
		.filter({ has: page.getByRole("combobox", { name: "判断の記録" }) })
		.last();
	const decisions = card.getByRole("combobox", { name: "判断の記録" });
	await expect(decisions).toHaveValue("90");
	await expect(
		card.getByRole("combobox", { name: "バックテストの実行" }),
	).toHaveValue("null");
	await expect(
		card.getByRole("combobox", { name: "足・ニュース・採点" }),
	).toHaveValue("5");
	await expect(card).toContainText("まだ削除していない");
	await expect(card).toContainText("DB の大きさ");
	await page.screenshot({
		path: `test-results/retention-${info.project.name}.png`,
		fullPage: true,
	});

	await decisions.selectOption("180");
	await card.getByRole("button", { name: "保存" }).click();
	await expect(card.getByText("保存した")).toBeVisible();
	await page.reload();
	await expect(card.getByRole("combobox", { name: "判断の記録" })).toHaveValue(
		"180",
	);
});
