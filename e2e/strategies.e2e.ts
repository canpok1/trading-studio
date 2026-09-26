import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

// スマホ幅と PC 幅で同じ DB を使うので、名前に project 名を入れる
async function createFromTemplate(page: Page, name: string, template: RegExp) {
	await page.getByRole("button", { name: "＋ 新しい戦略" }).click();
	const dialog = page.getByRole("dialog", { name: "新しい戦略" });
	await dialog.getByLabel("名前").fill(name);
	await dialog.getByRole("button", { name: template }).click();
	await expect(page.getByRole("status")).toHaveText(`「${name}」を作った`);
}

test("ひな形から作った戦略の条件を変えて保存すると、読み直しても残る", async ({
	page,
}, info) => {
	const name = `トレンド ${info.project.name}`;
	await page.goto("/strategies");
	await createFromTemplate(page, name, /^トレンド追随/);
	await expect(page.getByLabel("戦略", { exact: true })).toHaveValue(/\d+/);

	const save = page.getByRole("button", { name: "変更なし" });
	await expect(save).toBeDisabled();

	await page.getByLabel("長期EMA の本数").first().fill("60");
	await page
		.getByRole("region", { name: "売り注文（損切り）する条件" })
		.getByLabel("買値からの %")
		.fill("3");
	await page.getByRole("button", { name: "保存", exact: true }).click();
	await expect(page.getByRole("status")).toHaveText("保存した");

	await page.reload();
	await expect(page.getByLabel("長期EMA の本数").first()).toHaveValue("60");
	await expect(
		page
			.getByRole("region", { name: "売り注文（損切り）する条件" })
			.getByLabel("買値からの %"),
	).toHaveValue("3");
});

test("入力を誤ると保存できず、元に戻すと保存前の値に戻る", async ({
	page,
}, info) => {
	await page.goto("/strategies");
	await createFromTemplate(page, `誤り ${info.project.name}`, /^トレンド追随/);
	const pct = page
		.getByRole("region", { name: "売り注文（損切り）する条件" })
		.getByLabel("買値からの %");
	await pct.fill("");
	await expect(pct).toHaveAttribute("aria-invalid", "true");
	await expect(
		page.getByRole("button", { name: "入力を直すと保存できる" }),
	).toBeDisabled();
	await page.getByRole("button", { name: "元に戻す" }).click();
	await expect(pct).toHaveValue("2");
	await expect(page.getByRole("button", { name: "変更なし" })).toBeDisabled();
});

test("戦略の複製・リネーム・削除ができ、同じ名前は付けられない", async ({
	page,
}, info) => {
	const base = `レンジ ${info.project.name}`;
	await page.goto("/strategies");
	await createFromTemplate(page, base, /^レンジ逆張り/);

	// 同じ名前では作れない
	await page.getByRole("button", { name: "＋ 新しい戦略" }).click();
	const dialog = page.getByRole("dialog", { name: "新しい戦略" });
	await dialog.getByLabel("名前").fill(base);
	await dialog.getByRole("button", { name: /^空の戦略/ }).click();
	await expect(dialog.getByText("同じ名前の戦略がある")).toBeVisible();

	// 複製
	const copy = `${base} のコピー`;
	await dialog.getByLabel("名前").fill(copy);
	await dialog.getByRole("button", { name: `「${base}」を複製` }).click();
	await expect(page.getByRole("status")).toHaveText(`「${copy}」を作った`);

	// リネーム
	const renamed = `${base} 改`;
	await page.getByRole("button", { name: "この戦略をリネーム" }).click();
	const rename = page.getByRole("dialog", { name: "戦略の名前を変える" });
	await rename.getByLabel("新しい名前").fill(renamed);
	await rename.getByRole("button", { name: "名前を変える" }).click();
	await expect(page.getByRole("status")).toHaveText("名前を変えた");
	await expect(
		page.getByLabel("戦略", { exact: true }).locator("option:checked"),
	).toHaveText(renamed);

	// 削除
	await page.getByRole("button", { name: "この戦略を削除" }).click();
	const del = page.getByRole("dialog", { name: `「${renamed}」を削除する` });
	await del.getByRole("button", { name: "削除する" }).click();
	await expect(page.getByRole("status")).toHaveText("削除した");
	await expect(
		page
			.getByLabel("戦略", { exact: true })
			.locator("option", { hasText: renamed }),
	).toHaveCount(0);
});

test("戦略の画面は横にはみ出さない", async ({ page }) => {
	await page.goto("/strategies");
	await expect(
		page.getByRole("heading", { name: "戦略", level: 1 }),
	).toBeVisible();
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - window.innerWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
});

test("AI 判定の条件を追加して保存でき、値を1つも選ばないと保存できない", async ({
	page,
}, info) => {
	const name = `判定 ${info.project.name}`;
	await page.goto("/strategies");
	await createFromTemplate(page, name, /^トレンド追随/);
	const buy = page.getByRole("region", { name: "買い注文する条件" });
	await buy.getByRole("button", { name: "＋ 条件を追加" }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "リスク判定が指定のどれか" })
		.click();
	const risk = buy.getByRole("group").filter({ hasText: "リスク判定が" });
	await expect(risk.getByLabel("平常")).toBeChecked();
	await expect(risk.getByLabel("警戒")).toBeChecked();
	await expect(risk.getByLabel("危機")).not.toBeChecked();

	await risk.getByText("平常").click();
	await risk.getByText("警戒").click();
	await expect(risk).toContainText("1つ以上選ぶ");
	await expect(
		page.getByRole("button", { name: "入力を直すと保存できる" }),
	).toBeDisabled();

	await risk.getByText("平常").click();
	await page.getByRole("button", { name: "保存", exact: true }).click();
	await expect(page.getByRole("status")).toHaveText("保存した");
	await page.reload();
	const saved = page
		.getByRole("region", { name: "買い注文する条件" })
		.getByRole("group")
		.filter({ hasText: "リスク判定が" });
	await expect(saved.getByLabel("平常")).toBeChecked();
	await expect(saved.getByLabel("警戒")).not.toBeChecked();
});

test("買いの注文方法を指値に変えて値幅と本数を保存でき、成行では入力欄を出さない", async ({
	page,
}, info) => {
	await page.goto("/strategies");
	await createFromTemplate(
		page,
		`注文方法 ${info.project.name}`,
		/^トレンド追随/,
	);
	const buy = page.getByRole("region", { name: "買い注文する条件" });
	const below = buy.getByLabel("指値を現在値から下げる %");
	// トレンド追随のひな形は成行
	await expect(buy.getByRole("radio", { name: "成行" })).toBeChecked();
	await expect(below).toHaveCount(0);

	await buy.getByText("指値", { exact: true }).click();
	await below.fill("0.5");
	await buy.getByLabel("指値を取り消すまでの本数").fill("6");
	await page.getByRole("button", { name: "保存", exact: true }).click();
	await expect(page.getByRole("status")).toHaveText("保存した");

	await page.reload();
	await expect(buy.getByRole("radio", { name: "指値" })).toBeChecked();
	await expect(below).toHaveValue("0.5");
	await expect(buy.getByLabel("指値を取り消すまでの本数")).toHaveValue("6");

	await below.fill("100");
	await expect(below).toHaveAttribute("aria-invalid", "true");
	await expect(
		page.getByRole("button", { name: "入力を直すと保存できる" }),
	).toBeDisabled();
});
