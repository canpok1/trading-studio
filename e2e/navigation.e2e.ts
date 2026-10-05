import { expect, test } from "@playwright/test";

test("各画面へ移動できる", async ({ page, isMobile }) => {
	await page.goto("/");
	await expect(page).toHaveURL(/\/home$/);
	const nav = page.getByRole("navigation", { name: "メイン" });
	const items = isMobile
		? ["戦略", "ニュース", "その他", "バックテスト"]
		: [
				"ニュース",
				"戦略",
				"インポート",
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
		// スマホのインポート・エクスポート・設定は「その他」の中にある
		await nav.getByRole("link", { name: "その他" }).click();
		await page.getByRole("link", { name: /^インポート/ }).click();
		await expect(
			page.getByRole("heading", { level: 1, name: "インポート" }).first(),
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

test("PC のサイドメニューを畳め、再読み込み後も保たれる", async ({
	page,
	isMobile,
}) => {
	test.skip(isMobile, "スマホは下部タブで、畳む操作は無い");
	await page.goto("/home");
	const nav = page.getByRole("navigation", { name: "メイン" });
	const wide = (await nav.boundingBox())?.width ?? 0;
	await nav.getByRole("button", { name: "サイドメニューを畳む" }).click();
	await expect
		.poll(async () => (await nav.boundingBox())?.width ?? 0)
		.toBeLessThan(wide / 2);
	await page.reload();
	await expect(
		nav.getByRole("button", { name: "サイドメニューを広げる" }),
	).toBeVisible();
	// 畳んだままでも移動できる
	await nav.getByRole("link", { name: "設定", exact: true }).click();
	await expect(
		page.getByRole("heading", { level: 1, name: "設定" }),
	).toBeVisible();
});

test("旧名「AI判定」の URL はニュース画面へ移る", async ({ page }) => {
	await page.goto("/ai");
	await expect(page).toHaveURL(/\/news$/);
	await expect(
		page.getByRole("heading", { level: 1, name: "ニュース" }),
	).toBeVisible();
});

test("取引画面の URL はホームの同じモードの最初のタブへ移る", async ({
	page,
}) => {
	await page.goto("/trades?mode=paper");
	await expect(page).toHaveURL(/\/home\?mode=paper$/);
	await expect(page.getByRole("tab", { name: "デモ" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
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
