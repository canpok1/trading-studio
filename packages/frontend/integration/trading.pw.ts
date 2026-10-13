// ホームの自動取引（タブ・オンオフ・注文・口座のリセット）。ホームはチャートが canvas を使い happy-dom では描けないので、実ブラウザで確かめる
import type { Page } from "@playwright/test";
import { expect, test } from "./browser";
import { storedOrder, templateStrategy, tradingRun } from "./fixtures";
import { onHome } from "./home-api";

/** 注文の行の名前（「買 0.020 BTC · 約定 …」） */
const ORDER_ROW = / · (約定|注文中|取消)/;

/** 自動取引のカードの「⋯」からタブの設定を開く */
async function openRunSettings(page: Page) {
	await page.getByRole("button", { name: "タブの設定" }).click();
	return page.getByRole("dialog", { name: /の設定$/ });
}

test("運用する戦略を選ぶと知らせ、オンの間は状態が稼働中になり、運用する戦略を変えられず口座をリセットできない。オフで戻る", async ({
	page,
	api,
}) => {
	const name = "自動取引";
	onHome(api, {
		strategies: [templateStrategy(1, name)],
		runs: [tradingRun({ id: 1, name: "デモ" })],
	});
	await page.goto("/home");
	const select = (await openRunSettings(page)).getByLabel("運用する戦略");
	await select.selectOption({ label: name });
	await expect(page.getByRole("status")).toHaveText(
		`運用する戦略を「${name}」にした`,
	);
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "閉じる" })
		.click();
	await expect(page.getByTestId("auto-state")).toHaveText("停止中");
	await page.getByRole("switch", { name: "自動取引" }).click();
	await page
		.getByRole("dialog", { name: "「デモ」の自動取引を開始する（デモ）" })
		.getByRole("button", { name: "開始する" })
		.click();
	await expect(page.getByTestId("auto-state")).toHaveText("稼働中");
	let settings = await openRunSettings(page);
	await expect(settings.getByLabel("運用する戦略")).toBeDisabled();
	await settings.getByRole("button", { name: "閉じる" }).click();
	await expect(
		page.getByRole("button", { name: "口座をリセット" }),
	).toBeHidden();

	await page.getByRole("switch", { name: "自動取引" }).click();
	await expect(page.getByTestId("auto-state")).toHaveText("停止中");
	settings = await openRunSettings(page);
	await expect(settings.getByLabel("運用する戦略")).toBeEnabled();
	await settings.getByRole("button", { name: "閉じる" }).click();
	await expect(
		page.getByRole("button", { name: "口座をリセット" }),
	).toBeVisible();
});

test("稼働中の帯は他の画面にも出て、押すとホームの稼働中のタブへ移る", async ({
	page,
	api,
}) => {
	onHome(api, {
		runs: [
			tradingRun({ id: 1, name: "デモ" }),
			tradingRun({
				id: 2,
				name: "比較",
				enabled: true,
				strategy: { id: 1, name: "トレンド" },
			}),
		],
	});
	await page.goto("/strategies");
	const band = page.getByRole("complementary", { name: "稼働中の自動取引" });
	await expect(band).toContainText("デモ稼働中");
	await band.getByRole("link").click();
	await expect(page).toHaveURL(/\/home\?run=2$/);
	await expect(page.getByRole("tab", { name: /比較/ })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(page.getByRole("region", { name: "成績" })).toContainText(
		"勝率",
	);
});

test("タブを追加して戦略ごとに別々に動かせ、2つ稼働中なら帯に件数を出す。リアルのタブは動かせない。タブは削除できる", async ({
	page,
	api,
}) => {
	const name = "比較";
	const state = onHome(api, { strategies: [templateStrategy(1, name)] });
	await page.goto("/home");
	await expect(page.getByRole("tab")).toHaveCount(1);

	// デモのタブを足す。名前は選んだ戦略の名前になる
	await page.getByRole("button", { name: "タブを追加" }).click();
	let dialog = page.getByRole("dialog", { name: "タブを追加する" });
	await dialog.getByLabel("運用する戦略").selectOption({ label: name });
	await expect(dialog.getByLabel("タブの名前")).toHaveValue(name);
	await dialog.getByRole("button", { name: "追加する" }).click();
	const added = page.getByRole("tab", { name });
	await expect(added).toHaveAttribute("aria-selected", "true");
	await expect(page).toHaveURL(/\/home\?run=2$/);

	// 両方オンにすると、帯は件数とタブの名前を出す
	Object.assign(state.runs[0] as object, {
		enabled: true,
		strategy: { id: 1, name },
		strategyLock: "running",
	});
	await page.getByRole("switch", { name: "自動取引" }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "開始する" })
		.click();
	const band = page.getByRole("complementary", { name: "稼働中の自動取引" });
	// 先に動かしたタブは5秒ごとの読み直しで画面に届く
	await expect(band).toContainText("デモ 2件稼働中", { timeout: 10_000 });
	await expect(page.getByTestId("band-strategy")).toHaveText(`デモ・${name}`);
	// 稼働中はタブを消せない
	const settings = await openRunSettings(page);
	await expect(
		settings.getByRole("button", { name: "タブを削除" }),
	).toHaveCount(0);
	await settings.getByRole("button", { name: "閉じる" }).click();
	await page.getByRole("switch", { name: "自動取引" }).click();
	await expect(band).toContainText("デモ稼働中");
	for (const run of state.runs) run.enabled = false;

	// リアルのタブは1つまでで、動かせず口座・成績・注文を出さない
	await page.getByRole("button", { name: "タブを追加" }).click();
	dialog = page.getByRole("dialog", { name: "タブを追加する" });
	await dialog.getByRole("tab", { name: "リアル" }).click();
	await dialog.getByLabel("タブの名前").fill("リアル口座");
	await dialog.getByRole("button", { name: "追加する" }).click();
	await expect(page.getByTestId("auto-state")).toHaveText(
		"リアル取引はまだ使えない",
	);
	await expect(page.getByRole("switch", { name: "自動取引" })).toBeDisabled();
	await expect(page.getByRole("region", { name: "口座情報" })).toHaveCount(0);
	await expect(page.getByRole("region", { name: "注文・約定" })).toHaveCount(0);
	await page.getByRole("button", { name: "タブを追加" }).click();
	dialog = page.getByRole("dialog", { name: "タブを追加する" });
	await dialog.getByRole("tab", { name: "リアル" }).click();
	await expect(dialog.getByRole("button", { name: "追加する" })).toBeDisabled();
	await dialog.getByRole("button", { name: "やめる" }).click();

	// 足したタブを消すと、先頭のタブに戻る
	for (const tab of ["リアル口座", name]) {
		await page.getByRole("tab", { name: tab }).click();
		await (await openRunSettings(page))
			.getByRole("button", { name: "タブを削除" })
			.click();
		await page
			.getByRole("dialog")
			.getByRole("button", { name: "削除する" })
			.click();
		await expect(page.getByRole("tab", { name: tab })).toHaveCount(0);
	}
	await expect(page.getByRole("tab")).toHaveCount(1);
	// 最後の1つは消せない
	await expect(
		(await openRunSettings(page)).getByRole("button", { name: "タブを削除" }),
	).toHaveCount(0);
});

test("条件が足りない戦略は運用する戦略に選べない", async ({ page, api }) => {
	const name = "条件なし";
	onHome(api, { strategies: [templateStrategy(1, name, "blank")] });
	await page.goto("/home");
	const select = (await openRunSettings(page)).getByLabel("運用する戦略");
	await select.selectOption({ label: name });
	await expect(page.getByRole("status")).toHaveText(
		"この戦略は条件が足りないため選べない。「戦略」の画面で直す",
	);
	await expect(select).toHaveValue("");
	// タブを足すときも選べない
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "閉じる" })
		.click();
	await page.getByRole("button", { name: "タブを追加" }).click();
	await expect(
		page
			.getByRole("dialog", { name: "タブを追加する" })
			.getByLabel("運用する戦略")
			.getByRole("option", { name }),
	).toHaveCount(0);
});

test("注文を開くとそのときの市場評価が出て、注文を絞り込める。オフならリセットでき、過去の記録は残る", async ({
	page,
	api,
}) => {
	const now = Date.now();
	const state = onHome(api, {
		runs: [
			tradingRun({
				id: 1,
				name: "デモ",
				account: {
					...tradingRun({ id: 1, name: "デモ" }).account,
					cash: 980_000,
					position: {
						quantity: 2_000_000,
						entryPrice: 10_000_000,
						openedAt: now,
					},
					lots: [
						{
							id: "o1",
							buyId: "b1",
							entryPrice: 10_000_000,
							quantity: 2_000_000,
							openedAt: now,
						},
					],
					equity: 1_180_000,
				},
				strategyLock: "holding",
			}),
		],
		orders: [storedOrder({ id: "o1", placedAt: now, filledAt: now })],
	});
	await page.goto("/home");
	const recent = page.getByRole("region", { name: "注文・約定" });
	const rows = recent.getByRole("button", { name: ORDER_ROW });
	await expect(rows.first()).toContainText("買 0.020 BTC · 約定");
	await expect(page.getByTestId("account-equity")).toHaveText("1,180,000円");
	await expect(
		page.getByRole("region", { name: "口座情報" }),
	).not.toContainText("平均取得—");

	await rows.first().click();
	const sheet = page.getByRole("dialog", { name: "注文の詳細" });
	await expect(sheet).toContainText("このときの市場評価");
	await expect(sheet.getByTestId("badge-sentiment")).toBeVisible();
	await sheet.getByRole("button", { name: "閉じる" }).click();

	await expect(page.getByTestId("trades-summary")).toContainText(
		/^1 件 · 実現損益/,
	);
	await recent.getByRole("button", { name: "売", exact: true }).click();
	await expect(page.getByTestId("trades-summary")).toContainText("0 件");
	await expect(recent.getByText("条件に合う注文は無い")).toBeVisible();
	await recent.getByRole("button", { name: "絞り込みを解除" }).click();
	await recent.getByRole("button", { name: "買", exact: true }).click();
	await recent.getByRole("button", { name: "約定", exact: true }).click();
	await expect(page.getByTestId("trades-summary")).toContainText(/^1 件/);

	await page.getByRole("button", { name: "口座をリセット" }).click();
	const dialog = page.getByRole("dialog", { name: "口座をリセットする" });
	const cash = dialog.getByLabel("開始時の資金（円）");
	await expect(cash).toHaveValue("1,000,000");
	await cash.fill("500000");
	await dialog.getByRole("button", { name: "リセットする" }).click();
	await expect(page.getByRole("status")).toHaveText(
		"「デモ」の口座をリセットした。開始時の資金 500,000円",
	);
	await expect(page.getByTestId("home-unrealized")).toHaveText("—");
	// 5秒ごとの読み直しを待たずに、総資産と成績がリセット後の値になる
	await expect(page.getByTestId("account-equity")).toHaveText("500,000円", {
		timeout: 2_000,
	});
	await expect(rows).toHaveCount(state.orders.length);
});
