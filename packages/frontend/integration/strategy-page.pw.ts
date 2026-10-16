// ホームのチャートと表示の切り替え。チャート（lightweight-charts）は canvas に描くので happy-dom では動かず、実ブラウザで確かめる
import type { Page } from "@playwright/test";
import { strategyTemplate } from "@trading-studio/core";
import { expect, test } from "./browser";
import { templateStrategy, tradingRun } from "./fixtures";
import { onHome } from "./home-api";

/** チャート上端の「表示」のメニューを開く。線の表示の切り替えと本数の歯車はこの中にある */
async function openDisplay(page: Page) {
	const button = page.getByRole("button", { name: /^表示/ });
	if ((await button.getAttribute("aria-expanded")) !== "true") {
		await button.click();
	}
}

/** 戦略のタブを選ぶ */
async function chooseStrategy(page: Page, name: string) {
	await page.getByRole("tab", { name }).click();
}

const PRICE = /^[\d,]+円$/;

test("現在値と24時間の変化率が出て、5秒ごとに読み直して更新される", async ({
	page,
	api,
}) => {
	const state = onHome(api);
	await page.goto("/home");
	const price = page.getByTestId("chart-close");
	await expect(price).toHaveText("10,000,000円");
	await expect(page.getByTestId("home-change")).toHaveText(/^24h \+/);
	await expect(page.getByRole("img", { name: "価格チャート" })).toBeVisible();
	state.price = 10_500_000;
	await expect(price).toHaveText("10,500,000円", { timeout: 10_000 });
});

test("収集が止まるとエラーが出て、直ると消える", async ({ page, api }) => {
	const state = onHome(api);
	const running = state.collector;
	await page.goto("/home");
	await expect(page.getByTestId("chart-close")).toHaveText(PRICE);
	const alert = page.getByRole("alert").filter({
		hasText: "価格の収集が止まっている",
	});
	const now = Date.now();
	state.collector = {
		state: "stopped",
		stoppedSince: now,
		error: null,
		retryAt: now + 30_000,
		lastReceivedAt: now,
	};
	await expect(alert).toBeVisible({ timeout: 10_000 });
	await expect(alert).toContainText("止まった時刻");
	await expect(alert).toContainText("自動で再接続中");
	state.collector = running;
	await expect(alert).toBeHidden({ timeout: 10_000 });
});

test("EMA は戦略で使っていれば表示して始まり、どの粒度でも出せて、本数を変えられる", async ({
	page,
	api,
}) => {
	const trend = "トレンド";
	const range = "レンジ";
	onHome(api, {
		strategies: [
			templateStrategy(1, trend, "trend"),
			templateStrategy(2, range, "range"),
		],
		runs: [
			tradingRun({ id: 1, name: trend }),
			tradingRun({ id: 2, name: range }),
		],
	});
	await page.goto("/home");
	const ema = page.getByRole("button", { name: "EMA", exact: true });

	await chooseStrategy(page, trend);
	await openDisplay(page);
	await expect(ema).toHaveAttribute("aria-pressed", "true");
	// 既定は日足。戦略の条件の足（トレンド追随は1時間足）は見ない
	const tf = page.getByLabel("足の粒度");
	await expect(tf).toHaveValue("1d");

	// 選んだ足は再読み込みしても保たれ、どの足でも出す
	await tf.selectOption("5m");
	await page.reload();
	await expect(tf).toHaveValue("5m");
	await openDisplay(page);
	await expect(ema).toHaveAttribute("aria-pressed", "true");

	// EMA を使わない戦略では隠して始まる
	await chooseStrategy(page, range);
	await openDisplay(page);
	await expect(ema).toHaveAttribute("aria-pressed", "false");

	// 本数を変えると表示し、再読み込みしても保つ
	await page.getByRole("button", { name: "EMA の本数を変える" }).click();
	await page.getByLabel("EMA 1本目の本数").fill("9");
	await page.getByLabel("EMA 2本目の本数").fill("");
	await page.getByRole("button", { name: "表示する" }).click();
	await openDisplay(page);
	await expect(ema).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("chart-ema-9")).toHaveText(/^EMA9 [\d,]+$/);
	await page.reload();
	await openDisplay(page);
	await expect(ema).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("chart-ema-9")).toBeVisible();
	await page.getByRole("button", { name: "EMA の本数を変える" }).click();
	await page.getByRole("button", { name: "既定の値に戻す" }).click();
	await openDisplay(page);
	await expect(ema).toHaveAttribute("aria-pressed", "true");
	await page.getByRole("button", { name: "EMA の本数を変える" }).click();
	await expect(page.getByLabel("EMA 1本目の本数")).toHaveValue("20");
	await expect(page.getByLabel("EMA 2本目の本数")).toHaveValue("50");
	await page.getByRole("button", { name: "やめる" }).click();

	// 選んだ戦略は保存される
	await page.reload();
	await expect(page.getByTestId("auto-strategy")).toHaveText(range);
});

test("RSI の条件を持つ戦略を選ぶと RSI の小窓と値が出て、ボタンで隠せる", async ({
	page,
	api,
}) => {
	const params = strategyTemplate("trend").params;
	const buy = params.buys[0] as (typeof params.buys)[number];
	const rsiStrategy = templateStrategy(1, "RSI", "trend", {
		...params,
		buys: [
			{
				...buy,
				buy: {
					match: "all",
					conditions: [
						{
							type: "rsi",
							timeframe: "1m",
							period: 2,
							threshold: 30,
							direction: "below",
						},
					],
				},
			},
		],
	});
	onHome(api, {
		strategies: [rsiStrategy],
		runs: [tradingRun({ id: 1, name: "RSI" })],
	});
	await page.goto("/home");
	const toggle = page.getByRole("button", { name: "RSI", exact: true });
	const value = page.getByTestId("chart-rsi-2");
	await openDisplay(page);
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await expect(value).toHaveText(/^RSI2 \d+\.\d$/);
	await toggle.click();
	await expect(value).toBeHidden();
	await toggle.click();
	await expect(value).toBeVisible();

	// 条件の足以外でも出す
	await page.getByLabel("足の粒度").selectOption("5m");
	await openDisplay(page);
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await expect(value).toBeVisible();
});

test("ローソク足に切り替えると4本値が出て、再読み込み後も保たれる", async ({
	page,
	api,
}) => {
	onHome(api);
	await page.goto("/home");
	await expect(page.getByTestId("chart-close")).toHaveText(PRICE);
	const toggle = page.getByRole("button", { name: "ローソク足", exact: true });
	await openDisplay(page);
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByText(/^始 [\d,]+ 高 [\d,]+ 安 [\d,]+$/)).toBeVisible();

	await page.reload();
	await openDisplay(page);
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await expect(page.getByText(/^始 /)).toBeHidden();
});

for (const name of ["買値", "出来高"]) {
	test(`${name}は最初は出し、隠すと再読み込み後も隠したまま`, async ({
		page,
		api,
	}) => {
		onHome(api);
		await page.goto("/home");
		await expect(page.getByTestId("chart-close")).toHaveText(PRICE);
		const menu = page.getByRole("button", { name: /^表示/ });
		const toggle = page.getByRole("button", { name, exact: true });
		await expect(menu).toContainText(name);
		await openDisplay(page);
		await expect(toggle).toHaveAttribute("aria-pressed", "true");
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-pressed", "false");
		await expect(menu).not.toContainText(name);

		await page.reload();
		await expect(menu).not.toContainText(name);
		await openDisplay(page);
		await expect(toggle).toHaveAttribute("aria-pressed", "false");
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-pressed", "true");
	});
}

test("ホームは横にはみ出さない", async ({ page, api }) => {
	onHome(api);
	await page.goto("/home");
	await expect(page.getByTestId("chart-close")).toBeVisible();
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth > window.innerWidth,
	);
	expect(overflow).toBe(false);
});

test("PC 幅では要点が横一列（自動取引は右端）、その下にチャート、成績｜口座情報、注文・約定の順に並ぶ", async ({
	page,
	api,
	isMobile,
}) => {
	test.skip(isMobile, "横一列になるのは PC 幅だけ");
	onHome(api);
	await page.goto("/home");
	const box = async (name: string) => {
		const b = await page
			.getByRole("region", { name, exact: true })
			.boundingBox();
		if (!b) throw new Error(`${name} の位置を取れなかった`);
		return b;
	};
	await expect(page.getByRole("region", { name: "注文・約定" })).toBeVisible();
	const total = await box("通算損益");
	const unrealized = await box("含み損益");
	const market = await page
		.getByRole("link", { name: "市場評価（ニュースへ）" })
		.boundingBox();
	const auto = await box("自動取引設定");
	const chart = await box("価格チャート");
	const perf = await box("成績");
	const account = await box("口座情報");
	const orders = await box("注文・約定");
	if (!market) throw new Error("市場評価の位置を取れなかった");
	// 要点は同じ段に左から通算損益・含み損益・市場評価・自動取引
	for (const b of [unrealized, market, auto]) expect(b.y).toBe(total.y);
	expect(unrealized.x).toBeGreaterThan(total.x);
	expect(market.x).toBeGreaterThan(unrealized.x);
	expect(auto.x).toBeGreaterThan(market.x);
	// チャートは要点の下で、両方の列にまたがる
	expect(chart.y).toBeGreaterThan(total.y + total.height - 1);
	expect(chart.x).toBeLessThanOrEqual(total.x);
	expect(chart.x + chart.width).toBeGreaterThanOrEqual(auto.x + auto.width - 1);
	// その下の段に成績｜口座情報、最後に注文・約定
	expect(perf.y).toBeGreaterThan(chart.y + chart.height - 1);
	// 読み込みで上の段の高さが変わると、2つを測る間に位置がずれることがあるので、そろうまで測り直す
	await expect
		.poll(async () => (await box("口座情報")).y - (await box("成績")).y)
		.toBe(0);
	expect(account.x).toBeGreaterThan(perf.x + perf.width);
	expect(orders.y).toBeGreaterThan(perf.y + perf.height - 1);
});

test("チャートに市場評価の背景と帯が出て、帯をタップすると背景が入れ替わり、再読み込み後も保たれる", async ({
	page,
	api,
	isMobile,
}) => {
	onHome(api);
	await page.goto("/home");
	await expect(
		page.getByTestId("home-judge-sentiment").getByTestId("badge-sentiment"),
	).toBeVisible();
	// 上の値の表示の判定は短い観点名と、評価の色付きのバッジ
	const sentiment = page.getByTestId("chart-judgment-sentiment");
	await expect(sentiment).toContainText("センチ");
	await expect(sentiment.getByTestId("badge-sentiment")).toBeVisible();
	await expect(page.getByTestId("chart-judgment-risk")).toContainText("リスク");
	// スマホでは −/＋/最新へ を値の表示の下（チャートのすぐ上）に置く。PC では右
	const close = await page.getByTestId("chart-close").boundingBox();
	const latest = await page
		.getByRole("button", { name: "最新へ" })
		.boundingBox();
	if (!close || !latest) throw new Error("値の表示かボタンが無い");
	if (isMobile) {
		expect(latest.y).toBeGreaterThan(close.y + close.height);
	} else {
		expect(latest.x).toBeGreaterThan(close.x + close.width);
	}

	const bgSelect = page.getByLabel("背景に使う判定");
	await expect(bgSelect).toHaveValue("sentiment");
	// 背景がセンチメントのとき、帯はリスクの1本。その帯をタップする
	const chart = page.getByRole("img", { name: "価格チャート" });
	const box = await chart.boundingBox();
	if (!box) throw new Error("チャートが無い");
	// 指した足で上の値の表示の行数が変わるとチャートが上下にずれるので、先に同じ足の上の方を指してずれを済ませる
	await chart.hover({ position: { x: box.width / 2, y: 40 } });
	const moved = await chart.boundingBox();
	if (!moved) throw new Error("チャートが無い");
	// 下端から時間軸（約 26px）を除き、帯の中ほどの位置
	await chart.click({
		position: { x: moved.width / 2, y: moved.height - 26 - 10 },
	});
	await expect(bgSelect).toHaveValue("risk");
	await page.reload();
	await expect(page.getByLabel("背景に使う判定")).toHaveValue("risk");
});

test("ボリンジャーバンドは戦略で使っていなければ隠して始まり、本数と σ を変えると表示する", async ({
	page,
	api,
}) => {
	onHome(api);
	await page.goto("/home");
	await expect(page.getByTestId("chart-close")).toHaveText(PRICE);
	const bb = page.getByRole("button", { name: "BB", exact: true });
	await openDisplay(page);
	await expect(bb).toHaveAttribute("aria-pressed", "false");
	await expect(page.getByTestId("chart-bb")).toHaveCount(0);

	await page.getByRole("button", { name: "BB の本数を変える" }).click();
	await page.getByLabel("ボリンジャーバンドの σ", { exact: true }).fill("2.05");
	await expect(page.getByRole("button", { name: "表示する" })).toBeDisabled();
	await page.getByLabel("ボリンジャーバンドの本数", { exact: true }).fill("5");
	await page.getByLabel("ボリンジャーバンドの σ", { exact: true }).fill("1.5");
	await page.getByRole("button", { name: "表示する" }).click();
	await openDisplay(page);
	await expect(bb).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("chart-bb")).toHaveText(
		/^BB5 [\d,]+\/[\d,]+\/[\d,]+$/,
	);

	await page.getByRole("button", { name: "BB の本数を変える" }).click();
	await page.getByRole("button", { name: "既定の値に戻す" }).click();
	await expect(page.getByTestId("chart-bb")).toHaveText(/^BB20 /);
	await openDisplay(page);
	await bb.click();
	await expect(page.getByTestId("chart-bb")).toHaveCount(0);
});

test("次の動きと戦略の見張りが出て、グループの開閉を覚える", async ({
	page,
	api,
}) => {
	const name = "見張り";
	onHome(api, {
		strategies: [templateStrategy(1, name, "range")],
		runs: [tradingRun({ id: 1, name })],
	});
	await page.goto("/home");
	await expect(page.getByTestId("chart-close")).toHaveText(PRICE);
	await expect(page.getByRole("region", { name: "次の動き" })).toBeVisible();
	const panel = page.getByRole("region", { name: "戦略の見張り" });
	await expect(panel).toContainText("買い1");
	// グループは最初は閉じ、開いたものは再読み込みしても開いたまま
	const buyGroup = panel.locator("details").first();
	await expect(buyGroup).not.toHaveAttribute("open");
	await buyGroup.locator("summary").click();
	await expect(buyGroup).toHaveAttribute("open");
	await expect(page.getByRole("button", { name: /^表示/ })).toContainText(
		"発動価格",
	);

	await page.reload();
	await expect(buyGroup).toHaveAttribute("open");
	await buyGroup.locator("summary").click();
	await expect(buyGroup).not.toHaveAttribute("open");
});
