import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

// e2e/server.ts の DB と同じ場所。このファイルがあると偽物の取引所が止まる
const downFile = fileURLToPath(
	new URL("../.e2e-data/feed-down", import.meta.url),
);

/** チャート上端の「表示」のメニューを開く。線の表示の切り替えと本数の歯車はこの中にある */
async function openDisplay(page: Page) {
	const button = page.getByRole("button", { name: /^表示/ });
	if ((await button.getAttribute("aria-expanded")) !== "true") {
		await button.click();
	}
}

test("アプリを開くとホームが出て、現在値が自動で更新される", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page).toHaveURL(/\/home$/);
	const price = page.getByTestId("chart-close");
	await expect(price).toHaveText(/^[\d,]+円$/, { timeout: 15_000 });
	await expect(page.getByTestId("home-change")).toHaveText(/^24h /);
	const first = await price.textContent();
	// 偽物の取引所は1秒ごとに価格を変える。画面は5秒ごとに問い合わせる
	await expect(price).not.toHaveText(first as string, { timeout: 15_000 });
	await expect(page.getByRole("img", { name: "価格チャート" })).toBeVisible();
});

test("収集が止まると現在値の下にエラーが出て、直ると消える", async ({
	page,
}) => {
	await page.goto("/home");
	await expect(page.getByTestId("chart-close")).toHaveText(/^[\d,]+円$/, {
		timeout: 15_000,
	});
	const alert = page.getByRole("alert").filter({
		hasText: "価格の収集が止まっている",
	});
	writeFileSync(downFile, "");
	try {
		await expect(alert).toBeVisible({ timeout: 15_000 });
		await expect(alert).toContainText("止まった時刻");
		await expect(alert).toContainText("自動で再接続中");
	} finally {
		rmSync(downFile, { force: true });
	}
	await expect(alert).toBeHidden({ timeout: 30_000 });
});

test("EMA は戦略で使っていれば表示して始まり、どの粒度でも出せて、本数を変えられる", async ({
	page,
}, info) => {
	const create = async (name: string, template: string) => {
		const res = await page.request.post("/api/strategies", {
			data: { name, from: { template } },
		});
		expect(res.ok()).toBe(true);
	};
	const trend = `ホーム トレンド ${info.project.name}`;
	const range = `ホーム レンジ ${info.project.name}`;
	await create(trend, "trend");
	await create(range, "range");

	await page.goto("/home");
	const select = page.getByLabel("運用する戦略");
	const ema = page.getByRole("button", { name: "EMA", exact: true });

	await select.selectOption({ label: `${trend}` });
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
	await select.selectOption({ label: `${range}` });
	await openDisplay(page);
	await expect(ema).toHaveAttribute("aria-pressed", "false");

	// 本数を変えると表示し、再読み込みしても保つ
	await page.getByRole("button", { name: "EMA の本数を変える" }).click();
	await page.getByLabel("EMA 1本目の本数").fill("9");
	await page.getByLabel("EMA 2本目の本数").fill("");
	await page.getByRole("button", { name: "表示する" }).click();
	await openDisplay(page);
	await expect(ema).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("chart-ema-9")).toHaveText(/^EMA9 [\d,—]+$/, {
		timeout: 15_000,
	});
	await page.reload();
	await openDisplay(page);
	await expect(ema).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("chart-ema-9")).toBeVisible({
		timeout: 15_000,
	});
	await page.getByRole("button", { name: "EMA の本数を変える" }).click();
	await page.getByRole("button", { name: "既定の値に戻す" }).click();
	// 値の行はタップした位置の足（データの無い足のこともある）を指すことがあるので、本数は設定の画面で確かめる
	await openDisplay(page);
	await expect(ema).toHaveAttribute("aria-pressed", "true");
	await page.getByRole("button", { name: "EMA の本数を変える" }).click();
	await expect(page.getByLabel("EMA 1本目の本数")).toHaveValue("20");
	await expect(page.getByLabel("EMA 2本目の本数")).toHaveValue("50");
	await page.getByRole("button", { name: "やめる" }).click();

	// 選んだ戦略は保存される
	await page.reload();
	await expect(select.locator("option:checked")).toHaveText(
		new RegExp(`^${range}`),
	);
	await select.selectOption("");
});

test("RSI の条件を持つ戦略を選ぶと RSI の小窓と値が出て、ボタンで隠せる", async ({
	page,
}, info) => {
	const created = await page.request.post("/api/strategies", {
		data: {
			name: `ホーム RSI ${info.project.name}`,
			from: { template: "trend" },
		},
	});
	const { strategy } = (await created.json()) as {
		strategy: {
			id: number;
			params: { buys: Record<string, unknown>[] } & Record<string, unknown>;
		};
	};
	const params = {
		...strategy.params,
		buys: [
			{
				...strategy.params.buys[0],
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
	};
	expect(
		(
			await page.request.put(`/api/strategies/${strategy.id}/params`, {
				data: { params },
			})
		).ok(),
	).toBe(true);
	await page.request.put("/api/strategies/active", {
		data: { id: strategy.id },
	});
	try {
		await page.goto("/home");
		const toggle = page.getByRole("button", { name: "RSI", exact: true });
		const value = page.getByTestId("chart-rsi-2");
		await openDisplay(page);
		await expect(toggle).toHaveAttribute("aria-pressed", "true");
		await expect(value).toHaveText(/^RSI2 (\d+\.\d|—)$/, {
			timeout: 15_000,
		});
		await toggle.click();
		await expect(value).toBeHidden();
		await toggle.click();
		await expect(value).toBeVisible();

		// 条件の足以外でも出す
		await page.getByLabel("足の粒度").selectOption("5m");
		await openDisplay(page);
		await expect(toggle).toHaveAttribute("aria-pressed", "true");
		await expect(value).toBeVisible({ timeout: 15_000 });
	} finally {
		await page.request.put("/api/strategies/active", { data: { id: null } });
	}
});

test("ローソク足に切り替えると4本値が出て、再読み込み後も保たれる", async ({
	page,
}) => {
	await page.goto("/home");
	await expect(page.getByTestId("chart-close")).toHaveText(/^[\d,]+円$/, {
		timeout: 15_000,
	});
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

test("ホームは横にはみ出さない", async ({ page }) => {
	await page.goto("/home");
	await expect(page.getByTestId("chart-close")).toBeVisible();
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth > window.innerWidth,
	);
	expect(overflow).toBe(false);
});

test("PC 幅では上の4つのパネルが2列に並び、チャートと注文・約定は2列ぶんの幅を使う", async ({
	page,
}, testInfo) => {
	test.skip(testInfo.project.name !== "desktop", "2列になるのは PC 幅だけ");
	await page.goto("/home");
	const box = async (name: string) => {
		const b = await page
			.getByRole("region", { name, exact: true })
			.boundingBox();
		if (!b) throw new Error(`${name} の位置を取れなかった`);
		return b;
	};
	await expect(page.getByRole("region", { name: "価格チャート" })).toBeVisible({
		timeout: 15_000,
	});
	const auto = await box("自動取引設定");
	const account = await box("口座情報");
	const perf = await box("成績");
	const ai = await box("市場評価");
	const chart = await box("価格チャート");
	const orders = await box("注文・約定");
	// 自動取引設定の右に口座情報、その下の段に成績・市場評価
	expect(account.x).toBeGreaterThan(auto.x + auto.width);
	expect(perf.y).toBeGreaterThan(auto.y + auto.height);
	expect(ai.x).toBeGreaterThan(perf.x + perf.width);
	// チャートと注文・約定は両方の列にまたがる
	for (const b of [chart, orders]) {
		expect(b.y).toBeGreaterThan(ai.y + ai.height - 1);
		expect(b.x).toBeLessThanOrEqual(auto.x);
		expect(b.x + b.width).toBeGreaterThanOrEqual(account.x + account.width - 1);
	}
});

test("チャートに市場評価の背景と帯が出て、帯をタップすると背景が入れ替わり、再読み込み後も保たれる", async ({
	page,
}) => {
	// 足は1分ごとに閉じるので、採点が付いた後の足ができるまで待つことがある
	test.setTimeout(180_000);
	await page.goto("/home");
	await expect(page.getByTestId("home-judge-sentiment")).toContainText(/点|—/, {
		timeout: 20_000,
	});
	// 偽物の採点が付いた後に閉じた足ができるまで待つ
	await expect(async () => {
		await page.reload();
		await expect(page.getByTestId("chart-judgment-sentiment")).toBeVisible({
			timeout: 3_000,
		});
	}).toPass({ timeout: 120_000 });
	// 上の値の表示の判定は観点名付き
	await expect(page.getByTestId("chart-judgment-sentiment")).toContainText(
		"センチメント",
	);
	await expect(page.getByTestId("chart-judgment-risk")).toContainText("リスク");
	// スマホでは −/＋/最新へ を値の表示の下（チャートのすぐ上）に置く。PC では右
	const close = await page.getByTestId("chart-close").boundingBox();
	const latest = await page
		.getByRole("button", { name: "最新へ" })
		.boundingBox();
	if (!close || !latest) throw new Error("値の表示かボタンが無い");
	if ((page.viewportSize()?.width ?? 0) < 1024) {
		expect(latest.y).toBeGreaterThan(close.y + close.height);
	} else {
		expect(latest.x).toBeGreaterThan(close.x + close.width);
	}

	const bgSelect = page.getByLabel("背景に使う判定");
	await bgSelect.selectOption("sentiment");
	await expect(bgSelect).toHaveValue("sentiment");
	// 背景がセンチメントのとき、帯はリスクの1本。その帯をタップする
	const chart = page.getByRole("img", { name: "価格チャート" });
	// 指した足で上の値の表示の行数が変わり、チャートが上下にずれる（足の無い枠は「データなし」の1行）。
	// 帯は下端近くにあり、ずれると指す位置がチャートの外へ出て表示が戻り、ずれが止まらない。
	// 先に同じ足の上の方を指してずれを済ませてから、帯を押す
	const x = (await chart.boundingBox())?.width ?? 0;
	await chart.hover({ position: { x: x / 2, y: 40 } });
	const box = await chart.boundingBox();
	if (!box) throw new Error("チャートが無い");
	// 下端から時間軸（約 26px）を除き、帯の中ほどの位置
	await chart.click({
		position: { x: box.width / 2, y: box.height - 26 - 10 },
	});
	await expect(bgSelect).toHaveValue("risk");
	await page.reload();
	await expect(page.getByLabel("背景に使う判定")).toHaveValue("risk", {
		timeout: 20_000,
	});
});

test("ボリンジャーバンドは戦略で使っていなければ隠して始まり、本数と σ を変えると表示する", async ({
	page,
}) => {
	await page.goto("/home");
	await expect(page.getByTestId("chart-close")).toHaveText(/^[\d,]+円$/, {
		timeout: 15_000,
	});
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
		/^BB5 [\d,—]+\/[\d,—]+\/[\d,—]+$/,
	);

	await page.getByRole("button", { name: "BB の本数を変える" }).click();
	await page.getByRole("button", { name: "既定の値に戻す" }).click();
	await expect(page.getByTestId("chart-bb")).toHaveText(/^BB20 /);
	await openDisplay(page);
	await bb.click();
	await expect(page.getByTestId("chart-bb")).toHaveCount(0);
});
