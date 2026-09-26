import { expect, test } from "@playwright/test";

test("ホームで自動取引をオンにすると帯が全画面に出て、オン中は戦略とモードを変えられない。オフで帯が消える", async ({
	page,
}, info) => {
	const name = `自動取引 ${info.project.name}`;
	const res = await page.request.post("/api/strategies", {
		data: { name, from: { template: "trend" } },
	});
	expect(res.ok()).toBe(true);
	try {
		await page.goto("/home");
		const select = page.getByLabel("運用する戦略");
		await select.selectOption({ label: `${name}（1時間足）` });
		await expect(page.getByTestId("auto-loss")).toHaveText(
			"本日の損失 0 / 上限 30,000円",
		);
		await expect(page.getByRole("radio", { name: "ライブ" })).toBeDisabled();

		await page.getByRole("switch", { name: "自動取引" }).click();
		const dialog = page.getByRole("dialog", {
			name: "ペーパーで自動取引を開始する",
		});
		await expect(dialog).toContainText(name);
		await dialog.getByRole("button", { name: "開始する" }).click();
		await expect(page.getByRole("status")).toContainText("ペーパーで開始した");
		const band = page.getByRole("complementary", { name: "稼働中の自動取引" });
		await expect(band).toContainText("ペーパー稼働中");
		await expect(page.getByTestId("band-strategy")).toHaveText(name);
		await expect(page.getByTestId("auto-state")).toHaveText("稼働中");
		await expect(page.getByTestId("auto-next")).toHaveText(
			/^次の判定 \d{2}:\d{2}$/,
		);
		await expect(select).toBeDisabled();
		await expect(
			page.getByText("戦略とモードを変えるには先に OFF にする"),
		).toBeVisible();

		// 帯は他の画面にも出る
		await page.goto("/strategies");
		await expect(band).toBeVisible();

		await page.goto("/home");
		await page.getByRole("switch", { name: "自動取引" }).click();
		await expect(page.getByRole("status")).toHaveText(
			"自動取引を停止した。今から新しい注文は出ない",
		);
		await expect(band).toBeHidden();
		await expect(select).toBeEnabled();
	} finally {
		await page.request.post("/api/trading/stop");
	}
});

test("条件が足りない戦略は運用する戦略に選べない", async ({ page }, info) => {
	const name = `条件なし ${info.project.name}`;
	await page.request.post("/api/strategies", {
		data: { name, from: { template: "blank" } },
	});
	await page.goto("/home");
	const select = page.getByLabel("運用する戦略");
	const before = await select.inputValue();
	await select.selectOption({ label: `${name}（1時間足）` });
	await expect(page.getByRole("status")).toHaveText(
		"この戦略は条件が足りないため選べない。「戦略」の画面で直す",
	);
	await expect(select).toHaveValue(before);
});
