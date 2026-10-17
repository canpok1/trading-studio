import type { Page } from "@playwright/test";

/** チャートの設定（足・背景・表示・指標の本数）を開く。開いていれば何もしない */
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

/** チャート上の値の表示を広げる（畳んだ状態では日時と終値だけ）。設定を開く前に呼ぶ */
export async function openChartValues(page: Page) {
	const toggle = page.getByRole("button", { name: "チャートの値" });
	if ((await toggle.getAttribute("aria-expanded")) !== "true") {
		await toggle.click();
	}
}
