// ホーム（チャートと稼働中の戦略のカード）。チャート（lightweight-charts）は canvas に描くので happy-dom では動かず、実ブラウザで確かめる
import { expect, test } from "./browser";
import { openChartSettings, openChartValues } from "./chart-settings";
import { routes } from "./fake-api";
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

test("次の動きは優先度の高い上位2つだけ出し、オフの戦略は注文中のものだけ出す", async ({
	page,
	api,
}) => {
	const P = 10_000_000;
	onHome(api, {
		runs: fourRuns(),
		moves: [
			{
				kind: "entry",
				buyId: "b1",
				buyName: "買い1",
				trigger: { kind: "order", price: P - 150_000 },
			},
			{
				kind: "partialTakeProfit",
				buyId: "b1",
				buyName: "買い1",
				trigger: { kind: "price", price: P + 1_000_000 },
			},
			{
				kind: "takeProfit",
				buyId: "b1",
				buyName: "買い1",
				trigger: { kind: "remaining", count: 2 },
			},
		],
	});
	await page.goto("/home");
	const cards = page.getByTestId("home-strategy");
	await expect(cards.nth(0)).toContainText("−1.50%で買い（注文中）");
	await expect(cards.nth(0)).toContainText("+10.00%で一部利確");
	await expect(cards.nth(0)).not.toContainText("あと 2 条件");
	// 円の差はカードでは出さない
	await expect(cards.nth(0)).not.toContainText("1,000,000");
	await expect(cards.nth(2)).toContainText("停止中のため新しい注文は出さない");
	await expect(cards.nth(2)).toContainText("−1.50%で買い（注文中）");
	await expect(cards.nth(2)).not.toContainText("一部利確");
});

test("次の動きが無ければ「次の動きなし」と出す", async ({ page, api }) => {
	onHome(api, { runs: fourRuns(), moves: [] });
	await page.goto("/home");
	await expect(page.getByTestId("home-strategy").nth(0)).toContainText(
		"次の動きなし",
	);
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

test("カードを押すとそのカードが選択中になり、選択中のカードの「詳しく」で戦略の画面へ移る。選択は再読み込み後も保たれる", async ({
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

test("稼働中の戦略が無ければ、その旨と戦略の一覧への導線を出す", async ({
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

test("スマホは1列に切り替えると長い名前も切らずに出し、選んだ並べ方を覚えている。PC は切替を出さない", async ({
	page,
	api,
	isMobile,
}) => {
	const long = "トレンドフォロー 日足EMAクロス 損切り浅め 版3";
	const runs = fourRuns();
	runs.splice(
		0,
		1,
		withEquity(tradingRun({ id: 1, name: long, enabled: true }), 1_018_420),
	);
	onHome(api, { runs });
	await page.goto("/home");
	const layout = page.getByRole("group", { name: "並べ方" });
	if (!isMobile) {
		await expect(layout).toBeHidden();
		return;
	}
	const cards = page.getByTestId("home-strategy");
	const name = cards.nth(0).getByText(long);
	const clipped = () =>
		name.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
	// 2列は名前を1行で切る
	await expect(cards).toHaveCount(3);
	expect(await clipped()).toBe(true);
	await layout.getByRole("button", { name: "1列" }).click();
	await expect.poll(clipped).toBe(false);
	// 1列は名前を1行目の全幅に置き、値はその下の右。カードは縦に並ぶ
	const [a, b, value, label] = await Promise.all([
		cards.nth(0).boundingBox(),
		cards.nth(1).boundingBox(),
		cards.nth(0).getByTestId("home-strategy-value").boundingBox(),
		name.boundingBox(),
	]);
	if (!a || !b || !value || !label) throw new Error("見つからない");
	expect(b.y).toBeGreaterThan(a.y + a.height - 1);
	expect(value.y).toBeGreaterThanOrEqual(label.y + label.height);
	expect(value.x + value.width).toBeGreaterThan(a.x + a.width * 0.75);
	await page.reload();
	await expect(
		page.getByRole("button", { name: "1列", pressed: true }),
	).toBeVisible();
	await expect.poll(clipped).toBe(false);
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

/** 1時間足ごとに DVOL 55.23% を返す偽物。平均の日数 N を頼まれたら平均 (40 + N)% を付ける */
function onDvol(api: Parameters<typeof onHome>[0]) {
	api.on(routes.api.dvol.bars, "$get", (req) => {
		const from = Number(req.query.get("from"));
		const to = Number(req.query.get("to"));
		const days = req.query.get("averageDays");
		const bars = [];
		for (
			let t = Math.ceil(from / 3_600_000) * 3_600_000;
			t < to;
			t += 3_600_000
		) {
			bars.push({
				time: t,
				open: 5500,
				high: 5600,
				low: 5400,
				close: 5523,
				...(days ? { average: (40 + Number(days)) * 100 } : {}),
			});
		}
		return { bars };
	});
}

test("チャートの設定で DVOL を出すと小窓と値が出て、再読み込み後も保たれる", async ({
	page,
	api,
}) => {
	onHome(api, { runs: fourRuns() });
	onDvol(api);
	await page.goto("/home");
	await openChartValues(page);
	const value = page.getByTestId("chart-dvol");
	await expect(value).toHaveCount(0);
	await openChartSettings(page);
	await page.getByRole("button", { name: "DVOL", exact: true }).click();
	await page.keyboard.press("Escape");
	await expect(value).toHaveText("DVOL 55.2");
	await page.reload();
	await expect(page.getByTestId("chart-dvol")).toHaveText("DVOL 55.2");
});

test("チャートの設定で DVOL の平均を出すと平均と比が出て、日数を変えるとその日数の平均になる", async ({
	page,
	api,
}) => {
	onHome(api, { runs: fourRuns() });
	onDvol(api);
	await page.goto("/home");
	await openChartValues(page);
	await openChartSettings(page);
	await page.getByRole("button", { name: "DVOL", exact: true }).click();
	const avgButton = page.getByRole("button", { name: "DVOL の平均" });
	await expect(avgButton).toHaveAttribute("aria-pressed", "false");
	await avgButton.click();
	const days = page.getByRole("textbox", { name: "DVOL の平均の日数" });
	await expect(days).toHaveValue("30");
	const value = page.getByTestId("chart-dvol-average");
	await expect(value).toHaveText("平均30日 70.0（79%）");
	await days.fill("7");
	await page.keyboard.press("Escape");
	await expect(value).toHaveText("平均7日 47.0（118%）");
});
