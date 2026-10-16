// CUJ 2: デモ運用を始め、ホームで状況を見て、止める
import { expect, test } from "@playwright/test";

/** 注文の行の名前（「買 0.020 BTC · 約定 …」） */
const ORDER_ROW = / · (約定|注文中|取消)/;

test("デモ運用を始めると仮想注文が約定してホームに出て、止めると帯が消える", async ({
	page,
	isMobile,
}) => {
	// 1分足の終わりまで待つので、画面の幅に依らない流れは1回だけ通す
	test.skip(isMobile, "PC 幅だけで通す");
	test.setTimeout(150_000);
	const name = "CUJ デモ";

	// 毎分すぐ買う戦略は画面のひな形に無いので、条件だけ API で用意する
	const created = await page.request.post("/api/strategies", {
		data: { name, from: { template: "trend" } },
	});
	expect(created.status()).toBe(201);
	const { strategy } = (await created.json()) as {
		strategy: {
			id: number;
			params: { buys: Record<string, unknown>[] } & Record<string, unknown>;
		};
	};
	const params = {
		...strategy.params,
		frequency: {
			flat: { value: 1, unit: "m" },
			holding: { value: 1, unit: "m" },
		},
		buys: [
			{
				...strategy.params.buys[0],
				// 市場評価がどの値でも買う
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

	try {
		// 始める
		await page.goto("/home");
		await page.getByRole("tab", { name }).click();
		await page.getByRole("switch", { name: "自動取引" }).click();
		const confirm = page.getByRole("dialog", {
			name: `「${name}」の自動取引を開始する（デモ）`,
		});
		await confirm.getByRole("button", { name: "開始する" }).click();
		await expect(page.getByRole("status")).toContainText(
			`「${name}」を開始した`,
		);
		const band = page.getByRole("complementary", { name: "稼働中の自動取引" });
		await expect(band).toContainText("デモ稼働中");
		await expect(page.getByTestId("band-strategy")).toHaveText(name);

		// ホームで状況を見る。次の1分足の終わりに成行で買い、次に来た約定で約定する
		const rows = page
			.getByRole("region", { name: "注文・約定" })
			.getByRole("button", { name: ORDER_ROW });
		await expect(rows.first()).toContainText("買 0.020 BTC · 約定", {
			timeout: 90_000,
		});
		await expect(page.getByRole("region", { name: "口座情報" })).toContainText(
			"保有0.020 BTC",
		);
		await expect(page.getByRole("region", { name: "成績" })).toContainText(
			"取引回数",
		);
		await expect(page.getByTestId("band-pnl")).toHaveText(
			/^通算損益 [+−][\d,]+円（[+−]\d+\.\d%）$/,
		);

		// 止める
		await page.getByRole("switch", { name: "自動取引" }).click();
		await expect(page.getByRole("status")).toHaveText(
			"自動取引を停止した。今から新しい注文は出ない",
		);
		await expect(band).toBeHidden();
		await expect(page.getByTestId("auto-state")).not.toHaveText("稼働中");
	} finally {
		await page.request.post(`/api/trading/strategies/${strategy.id}/stop`);
		// 保有を残すと同じシャードの他のテストの口座の表示が変わるので、口座を戻す
		await page.request.post(`/api/trading/strategies/${strategy.id}/reset`, {
			data: { initialCash: 1_000_000 },
		});
	}
});
