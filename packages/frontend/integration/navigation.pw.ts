import { expect, test } from "./browser";

test("スマホは下部タブ、PC はサイドバーに、それぞれの項目が見える", async ({
	page,
	isMobile,
}) => {
	await page.goto("/home");
	const nav = page.getByRole("navigation", { name: "メイン" });
	const shown = isMobile
		? ["ホーム", "バックテスト", "戦略", "ニュース", "その他"]
		: [
				"ホーム",
				"バックテスト",
				"戦略",
				"ニュース",
				"インポート",
				"エクスポート",
				"設定",
			];
	const hidden = isMobile ? ["インポート", "エクスポート", "設定"] : ["その他"];
	for (const name of shown) {
		await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
	}
	for (const name of hidden) {
		await expect(nav.getByRole("link", { name, exact: true })).toBeHidden();
	}
});

test("PC のサイドメニューを畳むと細くなり、再読み込み後も保たれる", async ({
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
});

test("ライト / ダークの選択は再読み込み後も保たれる", async ({ page }) => {
	await page.emulateMedia({ colorScheme: "light" });
	await page.goto("/settings");
	const html = page.locator("html");
	await expect(html).not.toHaveClass(/dark/);
	await page.getByText("ダーク", { exact: true }).click();
	await page.reload();
	await expect(html).toHaveClass(/dark/);
	await expect(page.getByRole("radio", { name: "ダーク" })).toBeChecked();
});

test("テーマの初期値は OS の設定に従う", async ({ page }) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await page.goto("/settings");
	await expect(page.locator("html")).toHaveClass(/dark/);
	await expect(
		page.getByRole("radio", { name: "OS に合わせる" }),
	).toBeChecked();
});
