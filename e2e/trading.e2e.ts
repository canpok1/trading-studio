import { expect, test } from "@playwright/test";

/** 注文の行の名前（「買 0.020 · 約定 …」） */
const ORDER_ROW = / · (約定|注文中|取消)/;

test("ホームで自動取引をオンにすると帯が全画面に出て、オン中は戦略を変えられない。オフで帯が消える", async ({
	page,
}, info) => {
	const name = `自動取引 ${info.project.name}`;
	const res = await page.request.post("/api/strategies", {
		data: { name, from: { template: "trend" } },
	});
	expect(res.ok()).toBe(true);
	try {
		await page.goto("/home");
		const select = page.getByLabel("運用する戦略");
		await select.selectOption({ label: `${name}（1時間足）` });
		// ライブのタブはまだ開始できず、口座・成績・注文を出さない
		await page.getByRole("tab", { name: "ライブ" }).click();
		await expect(page).toHaveURL(/\/home\?mode=live$/);
		await expect(page.getByTestId("auto-state")).toHaveText(
			"ライブ取引はまだ使えない",
		);
		await expect(page.getByRole("switch", { name: "自動取引" })).toBeDisabled();
		await expect(page.getByRole("region", { name: "口座情報" })).toHaveCount(0);
		await expect(page.getByRole("region", { name: "注文・約定" })).toHaveCount(
			0,
		);
		await page.getByRole("tab", { name: "ペーパー" }).click();

		await page.getByRole("switch", { name: "自動取引" }).click();
		const dialog = page.getByRole("dialog", {
			name: "ペーパーで自動取引を開始する",
		});
		await expect(dialog).toContainText(name);
		await dialog.getByRole("button", { name: "開始する" }).click();
		await expect(page.getByRole("status")).toContainText("ペーパーで開始した");
		const band = page.getByRole("complementary", { name: "稼働中の自動取引" });
		await expect(band).toContainText("ペーパー稼働中");
		await expect(page.getByTestId("band-strategy")).toHaveText(name);
		await expect(page.getByTestId("band-pnl")).toHaveText(
			/^開始からの損益 [+−][\d,]+円（[+−]\d+\.\d%）$/,
		);
		await expect(page.getByTestId("auto-state")).toHaveText("稼働中");
		await expect(select).toBeDisabled();
		// 口座のリセットは停止中だけ
		await expect(
			page.getByRole("button", { name: "口座をリセット" }),
		).toBeHidden();

		// 帯は他の画面にも出て、押すとホームの稼働中のモードのタブへ移る
		await page.goto("/strategies");
		await expect(band).toBeVisible();
		await band.getByRole("link").click();
		await expect(page).toHaveURL(/\/home\?mode=paper$/);
		await expect(page.getByRole("region", { name: "成績" })).toContainText(
			"勝率",
		);

		await page.goto("/home");
		await page.getByRole("switch", { name: "自動取引" }).click();
		await expect(page.getByRole("status")).toHaveText(
			"自動取引を停止した。今から新しい注文は出ない",
		);
		await expect(band).toBeHidden();
		await expect(select).toBeEnabled();
	} finally {
		await page.request.post("/api/trading/stop");
	}
});

test("条件が足りない戦略は運用する戦略に選べない", async ({ page }, info) => {
	const name = `条件なし ${info.project.name}`;
	await page.request.post("/api/strategies", {
		data: { name, from: { template: "blank" } },
	});
	await page.goto("/home");
	const select = page.getByLabel("運用する戦略");
	const before = await select.inputValue();
	await select.selectOption({ label: `${name}（1時間足）` });
	await expect(page.getByRole("status")).toHaveText(
		"この戦略は条件が足りないため選べない。「戦略」の画面で直す",
	);
	await expect(select).toHaveValue(before);
});

test("仮想注文が出て約定すると、ホームの保有・注文に出て、注文を絞り込める。オフならリセットできる", async ({
	page,
	isMobile,
}) => {
	// 1分足の終わりまで待つので、画面の幅に依らない流れは1回だけ通す
	test.skip(isMobile, "PC 幅だけで通す");
	test.setTimeout(150_000);
	const created = await page.request.post("/api/strategies", {
		data: { name: "毎分買う", from: { template: "trend" } },
	});
	const { strategy } = (await created.json()) as {
		strategy: { id: number; params: Record<string, unknown> };
	};
	const params = {
		...strategy.params,
		timeframe: "1m",
		frequency: {
			flat: { value: 1, unit: "m" },
			holding: { value: 1, unit: "m" },
		},
		buy: {
			match: "all",
			conditions: [
				{
					type: "judgment",
					judge: "sentiment",
					values: ["+2", "+1", "0", "-1", "-2"],
				},
			],
		},
		takeProfit: {
			match: "any",
			conditions: [{ type: "entryChange", percent: 20, direction: "up" }],
		},
		stopLoss: {
			match: "any",
			conditions: [{ type: "entryChange", percent: 20, direction: "down" }],
		},
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
	expect(
		(
			await page.request.post("/api/trading/start", {
				data: { mode: "paper" },
			})
		).ok(),
	).toBe(true);
	try {
		await page.goto("/home");
		const recent = page.getByRole("region", { name: "注文・約定" });
		// 絞り込みのボタンと区別する
		const rows = recent.getByRole("button", { name: ORDER_ROW });
		// 次の1分足の終わりに成行で買い、次に来た約定で約定する
		await expect(rows.first()).toContainText("買 0.020 · 約定", {
			timeout: 90_000,
		});
		const position = page.getByRole("region", { name: "口座情報" });
		await expect(position).toContainText("保有 BTC0.020");
		await expect(page.getByTestId("account-equity")).toHaveText(/^[\d,]+円$/);
		await expect(page.getByRole("region", { name: "成績" })).toContainText(
			"取引回数",
		);
		await expect(position).not.toContainText("平均取得—");

		await rows.first().click();
		const sheet = page.getByRole("dialog", { name: "注文の詳細" });
		await expect(sheet).toContainText("このときの市場評価");
		await expect(sheet.getByTestId("badge-sentiment")).toBeVisible();
		await sheet.getByRole("button", { name: "閉じる" }).click();

		await expect(page.getByTestId("trades-summary")).toContainText(
			/^\d+ 件 · 実現損益/,
		);
		// 運用中のモード（ペーパー）のタブで開く
		await expect(page.getByRole("tab", { name: "ペーパー" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await recent.getByRole("button", { name: "売", exact: true }).click();
		await expect(page.getByTestId("trades-summary")).toContainText("0 件");
		await expect(recent.getByText("条件に合う注文は無い")).toBeVisible();
		await recent.getByRole("button", { name: "絞り込みを解除" }).click();
		await recent.getByRole("button", { name: "買", exact: true }).click();
		await recent.getByRole("button", { name: "約定", exact: true }).click();
		await expect(page.getByTestId("trades-summary")).not.toContainText(/^0 件/);
	} finally {
		await page.request.post("/api/trading/stop");
	}

	await page.goto("/home");
	await page.getByRole("button", { name: "口座をリセット" }).click();
	const dialog = page.getByRole("dialog", {
		name: "ペーパーの口座をリセットする",
	});
	const cash = dialog.getByLabel("開始時の資金（円）");
	await expect(cash).toHaveValue("1,000,000");
	await cash.fill("500000");
	await dialog.getByRole("button", { name: "リセットする" }).click();
	await expect(page.getByRole("status")).toHaveText(
		"ペーパーの口座をリセットした。開始時の資金 500,000円",
	);
	await expect(page.getByRole("region", { name: "口座情報" })).toContainText(
		"評価損益—",
	);
	// 5秒ごとの読み直しを待たずに、総資産と成績がリセット後の値になる
	await expect(page.getByTestId("account-equity")).toHaveText("500,000円", {
		timeout: 2_000,
	});
	// 過去の記録は残る
	await expect(
		page
			.getByRole("region", { name: "注文・約定" })
			.getByRole("button", { name: ORDER_ROW }),
	).not.toHaveCount(0);
});
