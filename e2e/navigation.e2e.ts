import { expect, test } from "@playwright/test";

test("各画面へ移動できる", async ({ page, isMobile }) => {
	await page.goto("/");
	await expect(page).toHaveURL(/\/home$/);
	const nav = page.getByRole("navigation", { name: "メイン" });
	const items = isMobile
		? ["戦略", "取引", "その他", "バックテスト"]
		: [
				"ニュース",
				"戦略",
				"取引",
				"過去データ",
				"エクスポート",
				"設定",
				"バックテスト",
			];
	for (const name of items) {
		await nav.getByRole("link", { name, exact: true }).click();
		await expect(
			page.getByRole("heading", { level: 1, name, exact: true }).first(),
		).toBeVisible();
	}
	if (isMobile) {
		// スマホのニュース・過去データ・エクスポート・設定は「その他」の中にある
		await nav.getByRole("link", { name: "その他" }).click();
		await page.getByRole("link", { name: /^ニュース/ }).click();
		await expect(
			page.getByRole("heading", { level: 1, name: "ニュース" }),
		).toBeVisible();
		await nav.getByRole("link", { name: "その他" }).click();
		await page.getByRole("link", { name: /過去データ/ }).click();
		await expect(
			page.getByRole("heading", { level: 1, name: "過去データ" }).first(),
		).toBeVisible();
		await nav.getByRole("link", { name: "その他" }).click();
		await page.getByRole("link", { name: /^エクスポート/ }).click();
		await expect(
			page.getByRole("heading", { level: 1, name: "エクスポート" }),
		).toBeVisible();
		await nav.getByRole("link", { name: "その他" }).click();
		await page.getByRole("link", { name: /^設定/ }).click();
		await expect(
			page.getByRole("heading", { level: 1, name: "設定" }),
		).toBeVisible();
	}
});

test("旧名「AI判定」の URL はニュース画面へ移る", async ({ page }) => {
	await page.goto("/ai");
	await expect(page).toHaveURL(/\/news$/);
	await expect(
		page.getByRole("heading", { level: 1, name: "ニュース" }),
	).toBeVisible();
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
