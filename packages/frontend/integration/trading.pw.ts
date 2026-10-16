// 戦略の一覧と戦略の画面（オンオフ・編集の入口・名前・複製・削除・注文・口座のリセット）。戦略の画面はチャートが canvas を使い happy-dom では描けないので、実ブラウザで確かめる
import type { Page } from "@playwright/test";
import { expect, test } from "./browser";
import { storedOrder, tradingRun } from "./fixtures";
import { onHome } from "./home-api";

/** 注文の行の名前（「買 0.020 BTC · 約定 …」） */
const ORDER_ROW = / · (約定|注文中|取消)/;

/** 戦略の画面の「⋯」から戦略の設定を開く */
async function openRunSettings(page: Page) {
	await page.getByRole("button", { name: "戦略の設定" }).click();
	return page.getByRole("dialog", { name: /の設定$/ });
}

test("オンの間は状態が稼働中になり、編集・削除・口座のリセットを出さない。オフで戻る", async ({
	page,
	api,
}) => {
	const name = "自動取引";
	onHome(api, { runs: [tradingRun({ id: 1, name })] });
	await page.goto("/strategies/1");
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
	await expect(page.getByTestId("auto-state")).toHaveText("停止中");
	await page.getByRole("switch", { name: "自動取引" }).click();
	await page
		.getByRole("dialog", { name: `「${name}」の自動取引を開始する（デモ）` })
		.getByRole("button", { name: "開始する" })
		.click();
	await expect(page.getByTestId("auto-state")).toHaveText("稼働中");
	await expect(page.getByRole("button", { name: "編集" })).toHaveCount(0);
	let settings = await openRunSettings(page);
	await expect(
		settings.getByRole("button", { name: "戦略を削除" }),
	).toHaveCount(0);
	await settings.getByRole("button", { name: "閉じる" }).click();
	await expect(
		page.getByRole("button", { name: "口座をリセット" }),
	).toBeHidden();

	await page.getByRole("switch", { name: "自動取引" }).click();
	await expect(page.getByTestId("auto-state")).toHaveText("停止中");
	await expect(page.getByRole("button", { name: "編集" })).toBeEnabled();
	settings = await openRunSettings(page);
	await expect(
		settings.getByRole("button", { name: "戦略を削除" }),
	).toBeVisible();
	await settings.getByRole("button", { name: "閉じる" }).click();
	await expect(
		page.getByRole("button", { name: "口座をリセット" }),
	).toBeVisible();
	await page.getByRole("button", { name: "編集" }).click();
	await expect(page).toHaveURL(/\/strategies\/1\/edit$/);
});

test("オフでも保有があれば編集ボタンを押せず、理由を出す", async ({
	page,
	api,
}) => {
	const run = tradingRun({ id: 1, name: "保有", strategyLock: "holding" });
	const lot = {
		id: "l1",
		buyId: "b1",
		quantity: 100_000,
		entryPrice: 10_000_000,
		openedAt: 0,
	};
	run.account.lots = [lot, { ...lot, id: "l2" }];
	onHome(api, { runs: [run] });
	await page.goto("/strategies/1");
	await expect(page.getByRole("button", { name: "編集" })).toBeDisabled();
	await expect(
		page.getByText(
			"保有が 2 ロットあるため編集できない。売り切るか口座をリセットすると編集できる",
		),
	).toBeVisible();
});

test("稼働中の帯は他の画面にも出て、1つなら押すとその戦略の画面へ移る", async ({
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
			}),
		],
	});
	await page.goto("/news");
	const band = page.getByRole("complementary", { name: "稼働中の自動取引" });
	await expect(band).toContainText("デモ稼働中");
	await band.getByRole("link").click();
	await expect(page).toHaveURL(/\/strategies\/2$/);
	await expect(page.getByRole("heading", { level: 1 })).toHaveText("比較");
	await expect(page.getByRole("region", { name: "成績" })).toContainText(
		"勝率",
	);
});

test("一覧は稼働中かと通算損益を出す。戦略ごとに別々に動かせ、2つ稼働中なら帯に件数を出す。リアルは動かせない", async ({
	page,
	api,
}) => {
	const name = "比較";
	const state = onHome(api, {
		runs: [
			tradingRun({ id: 1, name: "デモ" }),
			tradingRun({ id: 2, name }),
			tradingRun({ id: 3, name: "リアル口座", mode: "live" }),
		],
	});
	Object.assign(state.runs[1]?.account as object, { equity: 1_018_420 });
	(state.runs[1] as { ranSinceReset: boolean }).ranSinceReset = true;
	await page.goto("/strategies");
	const list = page.getByRole("list", { name: "戦略の一覧" });
	await expect(list.getByRole("listitem")).toHaveCount(3);
	await expect(list.getByRole("listitem").nth(0)).toContainText(
		"まだ動かしていない",
	);
	await expect(list.getByRole("listitem").nth(1)).toContainText(
		"通算 +18,420 円",
	);
	await expect(page.getByText("稼働中 0 / 5")).toBeVisible();

	// 両方オンにすると、帯は件数と戦略の名前を出し、押すと一覧へ
	Object.assign(state.runs[0] as object, {
		enabled: true,
		strategyLock: "running",
	});
	await list.getByRole("link", { name: new RegExp(name) }).click();
	await page.getByRole("switch", { name: "自動取引" }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "開始する" })
		.click();
	const band = page.getByRole("complementary", { name: "稼働中の自動取引" });
	// 先に動かした戦略は5秒ごとの読み直しで画面に届く
	await expect(band).toContainText("デモ 2件稼働中", { timeout: 10_000 });
	await expect(page.getByTestId("band-strategy")).toHaveText(`デモ・${name}`);
	await band.getByRole("link").click();
	await expect(page).toHaveURL(/\/strategies$/);
	await expect(page.getByTestId("strategy-state")).toHaveText([
		"● 稼働中",
		"● 稼働中",
		"停止中",
	]);
	await expect(page.getByText("稼働中 2 / 5")).toBeVisible();

	// リアルは動かせず、口座・成績・注文を出さない
	await list.getByRole("link", { name: /リアル口座/ }).click();
	await expect(page.getByTestId("auto-state")).toHaveText(
		"リアル取引はまだ使えない",
	);
	await expect(page.getByRole("switch", { name: "自動取引" })).toBeDisabled();
	await expect(page.getByRole("region", { name: "口座情報" })).toHaveCount(0);
	await expect(page.getByRole("region", { name: "注文・約定" })).toHaveCount(0);
});

test("「⋯」から名前を変え、複製すると複製の編集画面へ移り、削除すると一覧から消える", async ({
	page,
	api,
}) => {
	onHome(api, { runs: [tradingRun({ id: 1, name: "元" })] });
	await page.goto("/strategies/1");
	await (await openRunSettings(page))
		.getByRole("button", { name: "戦略の名前を変える" })
		.click();
	const rename = page.getByRole("dialog", { name: "戦略の名前を変える" });
	await rename.getByLabel("戦略の名前").fill("改");
	await rename.getByRole("button", { name: "変える" }).click();
	await expect(page.getByRole("heading", { level: 1 })).toHaveText("改");

	await (await openRunSettings(page))
		.getByRole("button", { name: "戦略を複製する" })
		.click();
	const copy = page.getByRole("dialog", { name: "戦略を複製する" });
	await expect(copy.getByLabel("名前")).toHaveValue("改のコピー");
	await copy.getByRole("button", { name: /^「改」を複製/ }).click();
	await expect(page).toHaveURL(/\/strategies\/2\/edit$/);
	await expect(
		page.getByRole("heading", { name: "「改のコピー」の編集" }),
	).toBeVisible();

	await page.getByRole("link", { name: "← 改のコピー" }).click();
	await (await openRunSettings(page))
		.getByRole("button", { name: "戦略を削除" })
		.click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "削除する" })
		.click();
	await expect(page).toHaveURL(/\/strategies$/);
	await expect(page.getByRole("status")).toHaveText("「改のコピー」を削除した");
	await expect(
		page.getByRole("list", { name: "戦略の一覧" }).getByRole("listitem"),
	).toHaveCount(1);
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
	await page.goto("/strategies/1");
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
