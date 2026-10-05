import type { Page } from "@playwright/test";

/** 自動取引のカードの「⋯」からタブの設定を開く */
export async function openRunSettings(page: Page) {
	await page.getByRole("button", { name: "タブの設定" }).click();
	return page.getByRole("dialog", { name: /の設定$/ });
}

/** タブの設定で運用する戦略を選び、設定を閉じる */
export async function chooseStrategy(page: Page, label: string | null) {
	const dialog = await openRunSettings(page);
	const select = dialog.getByLabel("運用する戦略");
	await (label === null
		? select.selectOption("")
		: select.selectOption({ label }));
	await dialog.getByRole("button", { name: "閉じる" }).click();
}
