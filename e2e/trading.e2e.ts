import { expect, test } from "@playwright/test";

test("ホームで自動取引をオンにすると帯が全画面に出て、オン中は戦略とモードを変えられない。オフで帯が消える", async ({
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
		await expect(page.getByTestId("auto-loss")).toHaveText(
			"本日の損失 0 / 上限 30,000円",
		);
		await expect(page.getByRole("radio", { name: "ライブ" })).toBeDisabled();

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
		await expect(page.getByTestId("auto-state")).toHaveText("稼働中");
		await expect(page.getByTestId("auto-next")).toHaveText(
			/^次の判定 \d{2}:\d{2}$/,
		);
		await expect(select).toBeDisabled();
		await expect(
			page.getByText("戦略とモードを変えるには先に OFF にする"),
		).toBeVisible();

		// 帯は他の画面にも出る
		await page.goto("/strategies");
		await expect(band).toBeVisible();

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

test("仮想注文が出て約定すると、ホームの保有・直近の注文と取引画面に出る。オフならリセットできる", async ({
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
				{ type: "judgment", judge: "trend", values: ["up", "range", "down"] },
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
		const recent = page.getByRole("region", { name: "直近の注文・約定" });
		// 次の1分足の終わりに成行で買い、次に来た約定で約定する
		await expect(recent.getByRole("button").first()).toContainText(
			"買 0.020 · 約定",
			{ timeout: 90_000 },
		);
		const position = page.getByRole("region", { name: "ペーパーの保有" });
		await expect(position).toContainText("保有0.020");
		await expect(position).not.toContainText("平均取得—");

		await recent.getByRole("button").first().click();
		const sheet = page.getByRole("dialog", { name: "注文の詳細" });
		await expect(sheet).toContainText("このときの判定");
		await expect(sheet.getByTestId("badge-trend")).toBeVisible();
		await sheet.getByRole("button", { name: "閉じる" }).click();

		await recent.getByRole("link", { name: "すべて" }).click();
		await expect(
			page.getByRole("heading", { level: 1, name: "取引" }),
		).toBeVisible();
		await expect(page.getByTestId("trades-summary")).toContainText(
			/^\d+ 件 · 実現損益/,
		);
		await expect(page.getByTestId("mode-tag").first()).toHaveText("ペーパー");
		await page.getByText("ライブ", { exact: true }).click();
		await expect(page.getByText("条件に合う取引はない")).toBeVisible();
		await page.getByRole("button", { name: "絞り込みを解除" }).click();
		await page.getByRole("button", { name: "売", exact: true }).click();
		await expect(page.getByTestId("trades-summary")).toContainText("0 件");
		await page.getByRole("button", { name: "買", exact: true }).click();
		await page.getByRole("button", { name: "約定", exact: true }).click();
		await expect(page.getByTestId("mode-tag").first()).toBeVisible();
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
	await expect(
		page.getByRole("region", { name: "ペーパーの保有" }),
	).toContainText("評価損益—");
	// 過去の記録は残る
	await expect(
		page.getByRole("region", { name: "直近の注文・約定" }).getByRole("button"),
	).not.toHaveCount(0);
});
