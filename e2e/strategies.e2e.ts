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

test("RSI の条件を追加して保存でき、範囲外の値では保存できない", async ({
	page,
}, info) => {
	await page.goto("/strategies");
	await createFromTemplate(page, `RSI ${info.project.name}`, /^トレンド追随/);
	const buy = page.getByRole("region", { name: "買い注文する条件" });
	await buy.getByRole("button", { name: "＋ 条件を追加" }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "RSI", exact: true })
		.click();
	const row = buy
		.getByRole("group")
		.filter({ has: page.getByLabel("RSI の本数") });
	await expect(row.getByLabel("RSI の本数")).toHaveValue("14");
	await expect(row.getByLabel("RSI のしきい値")).toHaveValue("30");
	await expect(row.getByLabel("以上・以下")).toHaveValue("below");

	await row.getByLabel("RSI のしきい値").fill("100");
	await expect(row).toContainText("1〜99 の整数で入れる");
	await expect(
		page.getByRole("button", { name: "入力を直すと保存できる" }),
	).toBeDisabled();

	await row.getByLabel("RSI のしきい値").fill("25");
	await page.getByRole("button", { name: "保存", exact: true }).click();
	await expect(page.getByRole("status")).toHaveText("保存した");
	await page.reload();
	const saved = page
		.getByRole("region", { name: "買い注文する条件" })
		.getByRole("group")
		.filter({ has: page.getByLabel("RSI の本数") });
	await expect(saved.getByLabel("RSI のしきい値")).toHaveValue("25");
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

test("最大ポジション数と指値の行を足して保存でき、逆順の % は保存できない", async ({
	page,
}, info) => {
	await page.goto("/strategies");
	await createFromTemplate(
		page,
		`複数ポジション ${info.project.name}`,
		/^レンジ逆張り/,
	);
	await page.getByLabel("最大ポジション数").fill("3");
	const buy = page.getByRole("region", { name: "買い注文する条件" });
	await buy.getByRole("button", { name: "＋ 指値を追加" }).click();
	const second = buy.getByLabel("2件目の指値を現在値から下げる %");
	await expect(second).toHaveValue("0.6");
	await second.fill("1");
	await page.getByRole("button", { name: "保存", exact: true }).click();
	await expect(page.getByRole("status")).toHaveText("保存した");

	await page.reload();
	await expect(page.getByLabel("最大ポジション数")).toHaveValue("3");
	await expect(second).toHaveValue("1");

	await second.fill("0.05");
	await expect(second).toHaveAttribute("aria-invalid", "true");
	// 行の下に1回だけ出す
	await expect(
		buy.getByText("上の行（0.1%）より大きくする", { exact: true }),
	).toHaveCount(1);
	await expect(
		page.getByRole("button", { name: "入力を直すと保存できる" }),
	).toBeDisabled();
});

test("1日の損失上限を変えて保存でき、0 円は保存できない", async ({
	page,
}, info) => {
	await page.goto("/strategies");
	await createFromTemplate(
		page,
		`損失上限 ${info.project.name}`,
		/^トレンド追随/,
	);
	const limit = page.getByLabel("1日の損失上限（円）");
	await expect(limit).toHaveValue("30,000");
	await limit.fill("50000");
	await page.getByRole("button", { name: "保存", exact: true }).click();
	await expect(page.getByRole("status")).toHaveText("保存した");
	await page.reload();
	await expect(limit).toHaveValue("50,000");

	await limit.fill("0");
	await expect(limit).toHaveAttribute("aria-invalid", "true");
	await expect(
		page.getByRole("button", { name: "入力を直すと保存できる" }),
	).toBeDisabled();
});

test("終値と EMA の位置・ボリンジャーバンド・最高値からの %・買ってからの本数を追加して保存でき、買いには売り専用の条件が出ない", async ({
	page,
}, info) => {
	await page.goto("/strategies");
	await createFromTemplate(
		page,
		`条件追加 ${info.project.name}`,
		/^トレンド追随/,
	);
	const add = async (group: string, name: string) => {
		await page
			.getByRole("region", { name: group })
			.getByRole("button", { name: "＋ 条件を追加" })
			.click();
		await page.getByRole("dialog").getByRole("button", { name }).click();
	};
	const buy = page.getByRole("region", { name: "買い注文する条件" });
	await buy.getByRole("button", { name: "＋ 条件を追加" }).click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByRole("button", { name: /トレーリングストップ/ }),
	).toHaveCount(0);
	await expect(
		dialog.getByRole("button", { name: "買ってからの本数" }),
	).toHaveCount(0);
	await dialog.getByRole("button", { name: "やめる" }).click();

	await add("買い注文する条件", "終値と EMA の位置");
	await expect(buy.getByLabel("EMA の本数", { exact: true })).toHaveValue(
		"200",
	);
	await expect(buy.getByLabel("上下", { exact: true })).toHaveValue("above");
	await add("買い注文する条件", "ボリンジャーバンド");
	await expect(
		buy.getByLabel("ボリンジャーバンドの本数", { exact: true }),
	).toHaveValue("20");
	await expect(
		buy.getByLabel("ボリンジャーバンドの σ", { exact: true }),
	).toHaveValue("2");
	await expect(buy.getByLabel("上限・下限", { exact: true })).toHaveValue(
		"lower",
	);

	const tp = page.getByRole("region", { name: "売り注文（利確）する条件" });
	await add("売り注文（利確）する条件", "買ってからの本数");
	await expect(tp.getByLabel("買ってからの本数", { exact: true })).toHaveValue(
		"24",
	);
	const sl = page.getByRole("region", { name: "売り注文（損切り）する条件" });
	await add("売り注文（損切り）する条件", /トレーリングストップ/);
	await expect(sl.getByLabel("最高値からの %", { exact: true })).toHaveValue(
		"3",
	);

	await buy.getByLabel("ボリンジャーバンドの σ", { exact: true }).fill("2.55");
	await expect(buy).toContainText("0.1〜5、0.1 刻みで入れる");
	await expect(
		page.getByRole("button", { name: "入力を直すと保存できる" }),
	).toBeDisabled();
	await buy.getByLabel("ボリンジャーバンドの σ", { exact: true }).fill("2.5");
	await sl.getByLabel("最高値からの %", { exact: true }).fill("5");
	await page.getByRole("button", { name: "保存", exact: true }).click();
	await expect(page.getByRole("status")).toHaveText("保存した");

	await page.reload();
	await expect(
		page
			.getByRole("region", { name: "買い注文する条件" })
			.getByLabel("ボリンジャーバンドの σ", { exact: true }),
	).toHaveValue("2.5");
	await expect(
		page
			.getByRole("region", { name: "売り注文（損切り）する条件" })
			.getByLabel("最高値からの %", { exact: true }),
	).toHaveValue("5");
	await expect(
		page
			.getByRole("region", { name: "売り注文（利確）する条件" })
			.getByLabel("買ってからの本数", { exact: true }),
	).toHaveValue("24");
});
