import { expect, test } from "@playwright/test";

test("各画面へ移動できる", async ({ page, isMobile }) => {
	await page.goto("/");
	await expect(page).toHaveURL(/\/home$/);
	const nav = page.getByRole("navigation", { name: "メイン" });
	const items = isMobile
		? ["AI判定", "戦略", "その他", "バックテスト"]
		: ["AI判定", "戦略", "過去データ", "設定", "バックテスト"];
	for (const name of items) {
		await nav.getByRole("link", { name, exact: true }).click();
		await expect(
			page.getByRole("heading", { level: 1, name, exact: true }).first(),
		).toBeVisible();
	}
	if (isMobile) {
		// スマホの過去データと設定は「その他」の中にある
		await nav.getByRole("link", { name: "その他" }).click();
		await page.getByRole("link", { name: /過去データ/ }).click();
		await expect(
			page.getByRole("heading", { level: 1, name: "過去データ" }).first(),
		).toBeVisible();
		await nav.getByRole("link", { name: "その他" }).click();
		await page.getByRole("link", { name: /^設定/ }).click();
		await expect(
			page.getByRole("heading", { level: 1, name: "設定" }),
		).toBeVisible();
	}
});

test("ライト / ダークを切り替えられ、再読み込み後も保たれる", async ({
	page,
}) => {
	await page.emulateMedia({ colorScheme: "light" });
	await page.goto("/settings");
	const html = page.locator("html");
	await expect(html).not.toHaveClass(/dark/);
	await page.getByText("ダーク", { exact: true }).click();
	await expect(html).toHaveClass(/dark/);
	await page.reload();
	await expect(html).toHaveClass(/dark/);
	await expect(page.getByRole("radio", { name: "ダーク" })).toBeChecked();
});

test("初期値は OS の設定に従う", async ({ page }) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await page.goto("/settings");
	await expect(page.locator("html")).toHaveClass(/dark/);
	await expect(
		page.getByRole("radio", { name: "OS に合わせる" }),
	).toBeChecked();
});
