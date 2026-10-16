// ホーム（チャートと稼働中の戦略のカード）。チャート（lightweight-charts）は canvas に描くので happy-dom では動かず、実ブラウザで確かめる
import { expect, test } from "./browser";
import { tradingRun } from "./fixtures";
import { onHome } from "./home-api";

const withEquity = (
	run: ReturnType<typeof tradingRun>,
	equity: number,
): ReturnType<typeof tradingRun> => ({
	...run,
	account: { ...run.account, equity },
});

/** オンの2つ、オフで保有がある1つ、止まっている1つ */
function fourRuns() {
	return [
		withEquity(
			tradingRun({ id: 1, name: "トレンド", enabled: true }),
			1_018_420,
		),
		tradingRun({ id: 2, name: "止まっている" }),
		withEquity(tradingRun({ id: 3, name: "逆張り", enabled: true }), 992_650),
		withEquity(
			tradingRun({ id: 4, name: "売り待ち", strategyLock: "holding" }),
			1_003_080,
		),
	];
}

test("オンの戦略とオフでも保有がある戦略を作った順にカードで出し、止まっている戦略は件数だけ出す", async ({
	page,
	api,
}) => {
	onHome(api, { runs: fourRuns() });
	await page.goto("/home");
	const cards = page.getByTestId("home-strategy");
	await expect(cards).toHaveCount(3);
	await expect(cards.nth(0)).toContainText("トレンド");
	await expect(cards.nth(1)).toContainText("逆張り");
	await expect(cards.nth(2)).toContainText("売り待ち");
	await expect(cards.nth(2)).toContainText("停止中（保有・注文あり）");
	await expect(cards.nth(0).getByTestId("home-strategy-value")).toHaveText(
		"+18,420円",
	);
	await expect(cards.nth(1).getByTestId("home-strategy-value")).toHaveText(
		"−7,350円",
	);
	// 次の動きは % と種類だけ（円の差は戦略の画面で出す）
	await expect(cards.nth(0)).toContainText("−2.00%で");
	await expect(cards.nth(0)).not.toContainText("−200,000");
	await page.getByRole("link", { name: /停止中 1 件/ }).click();
	await expect(page).toHaveURL(/\/strategies$/);
});

test("比べる値を切り替えると全カードの値が変わり、再読み込み後も保たれる", async ({
	page,
	api,
}) => {
	onHome(api, { runs: fourRuns() });
	await page.goto("/home");
	const first = page.getByTestId("home-strategy").first();
	await expect(first.getByTestId("home-strategy-value")).toHaveText(
		"+18,420円",
	);
	await page.getByRole("combobox", { name: "比べる値" }).selectOption("trades");
	await expect(first.getByTestId("home-strategy-value")).toHaveText("0回");
	await page.reload();
	await expect(page.getByRole("combobox", { name: "比べる値" })).toHaveValue(
		"trades",
	);
	await expect(first.getByTestId("home-strategy-value")).toHaveText("0回");
});

test("カードを押すとチャートの印がその戦略になり、選択中のカードの「詳しく」で戦略の画面へ移る。選択は再読み込み後も保たれる", async ({
	page,
	api,
}) => {
	onHome(api, { runs: fourRuns() });
	await page.goto("/home");
	// 最初は先頭の戦略
	await expect(page.getByRole("button", { name: /^トレンド/ })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	const second = page.getByRole("button", { name: /^逆張り/ });
	await second.click();
	await expect(second).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByRole("link", { name: "詳しく ›" })).toHaveCount(1);
	await page.reload();
	await expect(second).toHaveAttribute("aria-pressed", "true");
	await page.getByRole("link", { name: "詳しく ›" }).click();
	await expect(page).toHaveURL(/\/strategies\/3$/);
});

test("稼働中の戦略が無ければ、その旨と戦略の一覧への導線を出す。チャートに印は付けない", async ({
	page,
	api,
}) => {
	onHome(api, { runs: [tradingRun({ id: 1, name: "止まっている" })] });
	await page.goto("/home");
	await expect(page.getByText(/稼働中の戦略は無い/)).toBeVisible();
	await expect(page.getByTestId("chart-close")).toBeVisible();
	await page.getByRole("link", { name: "戦略を見る" }).click();
	await expect(page).toHaveURL(/\/strategies$/);
});

test("スマホはカードを2列、PC は全幅のチャートの下に横一列で並べる", async ({
	page,
	api,
	isMobile,
}) => {
	onHome(api, { runs: fourRuns() });
	await page.goto("/home");
	const cards = page.getByTestId("home-strategy");
	await expect(cards).toHaveCount(3);
	const chart = await page
		.getByRole("region", { name: "価格チャート" })
		.boundingBox();
	const boxes = await Promise.all(
		[0, 1, 2].map((i) => cards.nth(i).boundingBox()),
	);
	const [a, b, c] = boxes;
	if (!chart || !a || !b || !c) throw new Error("見つからない");
	expect(a.y).toBeGreaterThan(chart.y + chart.height);
	expect(b.y).toBe(a.y);
	if (isMobile) {
		// 3枚目は次の行。下部タブに隠れずに2行目の値まで見える（最初の画面に4枚入る）
		expect(c.y).toBeGreaterThan(a.y + a.height);
		const value = await cards
			.nth(2)
			.getByTestId("home-strategy-value")
			.boundingBox();
		const nav = await page
			.getByRole("navigation", { name: "メイン" })
			.boundingBox();
		if (!value || !nav) throw new Error("見つからない");
		expect(value.y + value.height).toBeLessThan(nav.y);
	} else {
		expect(c.y).toBe(a.y);
		// チャートは全幅
		expect(c.x + c.width).toBeGreaterThan(chart.x + chart.width / 2);
	}
});

test("−・＋を「最新へ」と同じ行に出し、押しても最新の足は見えたまま", async ({
	page,
	api,
}) => {
	onHome(api, { runs: fourRuns() });
	await page.goto("/home");
	const latest = await page
		.getByRole("button", { name: "最新へ" })
		.boundingBox();
	const minus = page.getByRole("button", { name: "縮小" });
	const plus = page.getByRole("button", { name: "拡大" });
	await expect(minus).toBeVisible();
	await expect(plus).toBeVisible();
	const m = await minus.boundingBox();
	const p = await plus.boundingBox();
	if (!latest || !m || !p) throw new Error("見つからない");
	expect(Math.abs(m.y - latest.y)).toBeLessThan(latest.height);
	expect(Math.abs(p.y - latest.y)).toBeLessThan(latest.height);
	// 最新が見えている間は右端を保つので、拡大・縮小しても最新の足は見えたまま
	await plus.click();
	await minus.click();
	await expect(page.getByRole("button", { name: "最新へ" })).toBeDisabled();
});
