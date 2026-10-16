import type { Page } from "@playwright/test";

/** チャートの設定（足・背景・線の表示と本数の歯車）を開く。開いていれば何もしない */
export async function openChartSettings(page: Page) {
	if (await page.getByRole("dialog", { name: "チャートの設定" }).isVisible()) {
		return;
	}
	await page.getByRole("button", { name: "チャートの設定" }).click();
}

/** 凡例はチャートの「？」の吹き出しの中にある */
export async function openChartLegend(page: Page) {
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "チャートの説明" }).first().click();
}
