import { expect, test } from "@playwright/test";

function csv(startMs: number, rows: number): string {
	const lines = ["日時,始値,高値,安値,終値,出来高"];
	for (let i = 0; i < rows; i++) {
		const t = new Date(startMs + i * 60_000).toISOString();
		lines.push(`${t},13000000,13010000,12990000,13000000,0.5`);
	}
	return lines.join("\n");
}

test("CSV を選ぶと取り込まれ、一覧に期間が増える", async ({ page }, info) => {
	// スマホ幅と PC 幅で同じ DB を使うので、日付をずらす
	const day =
		info.project.name === "mobile"
			? Date.UTC(2026, 0, 1)
			: Date.UTC(2026, 1, 1);
	await page.goto("/data");
	await page
		.getByRole("region", { name: "CSV の取り込み" })
		.getByText("1分", { exact: true })
		.click();
	await page.locator('input[type="file"]').setInputFiles({
		name: "btc.csv",
		mimeType: "text/csv",
		buffer: Buffer.from(csv(day, 120)),
	});
	await expect(
		page.getByRole("status").filter({ hasText: "120 行を取り込んだ" }),
	).toBeVisible();
	const history = page.getByRole("region", { name: "取り込みの履歴" });
	const jst = new Date(day + 9 * 3600_000);
	const label = `${jst.getUTCFullYear()}/${String(jst.getUTCMonth() + 1).padStart(2, "0")}/${String(jst.getUTCDate()).padStart(2, "0")}`;
	await expect(history.getByText(`${label}〜${label}`).first()).toBeVisible();
	await expect(page.getByRole("img", { name: /^日足:/ })).toBeVisible();
});

test("既存の足と重なる CSV は確認が出て、上書きする・しないを選べる", async ({
	page,
}, info) => {
	const day =
		info.project.name === "mobile"
			? Date.UTC(2026, 2, 1)
			: Date.UTC(2026, 2, 15);
	const upload = (price: number) =>
		page.locator('input[type="file"]').setInputFiles({
			name: "again.csv",
			mimeType: "text/csv",
			buffer: Buffer.from(
				csv(day, 10).replace(
					/13000000,13010000,12990000,13000000/g,
					`${price},${price},${price},${price}`,
				),
			),
		});
	await page.goto("/data");
	await page
		.getByRole("region", { name: "CSV の取り込み" })
		.getByText("1分", { exact: true })
		.click();
	await upload(13_000_000);
	await expect(
		page.getByRole("status").filter({ hasText: "10 行を取り込んだ" }),
	).toBeVisible();

	// 上書きしない：重なる足は読み飛ばす
	await upload(14_000_000);
	const confirm = page.getByRole("region", { name: "既存の足との重なり" });
	await expect(confirm).toContainText("10 本");
	await confirm.getByRole("button", { name: /^上書きしない/ }).click();
	await expect(
		page.getByRole("status").filter({ hasText: "10 行は読み飛ばした" }),
	).toBeVisible();
	const close = async () => {
		const r = await page.request.get(`/api/market/bars?timeframe=1d&range=all`);
		const { bars } = (await r.json()) as {
			bars: { time: number; close: number }[];
		};
		const jstDay = day - 9 * 3_600_000;
		return bars.find((b) => b.time === jstDay)?.close;
	};
	expect(await close()).toBe(13_000_000);

	// 上書きする：既存の足と、そこから作った日足が置き換わる
	await upload(14_000_000);
	await confirm.getByRole("button", { name: "上書きする" }).click();
	await expect(
		page.getByRole("status").filter({ hasText: "10 行を取り込んだ" }),
	).toBeVisible();
	expect(await close()).toBe(14_000_000);
});

test("不正な CSV ではエラーと原因の行が表示される", async ({ page }) => {
	await page.goto("/data");
	await page.locator('input[type="file"]').setInputFiles({
		name: "broken.csv",
		mimeType: "text/csv",
		buffer: Buffer.from(
			"日時,始値,高値,安値,終値,出来高\n2026-08-01 05:11:00,1,1,1,1,0\n",
		),
	});
	const alert = page.getByRole("alert");
	await expect(alert).toContainText("broken.csv");
	await expect(alert).toContainText("2 行目");
	await expect(alert).toContainText("タイムゾーンの無い日時は受け付けない");
	await expect(alert.getByText("別のファイルを選ぶ")).toBeVisible();
});

test("横にはみ出さない", async ({ page }) => {
	await page.goto("/data");
	await expect(
		page.getByRole("heading", { name: "取り込み済み" }),
	).toBeVisible();
	const overflow = await page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
});

test("保存済みの足を期間を選んで CSV で書き出せる", async ({ page }, info) => {
	const day =
		info.project.name === "mobile"
			? Date.UTC(2026, 3, 1)
			: Date.UTC(2026, 3, 15);
	await page.goto("/data");
	await page
		.getByRole("region", { name: "CSV の取り込み" })
		.getByText("1分", { exact: true })
		.click();
	await page.locator('input[type="file"]').setInputFiles({
		name: "export.csv",
		mimeType: "text/csv",
		buffer: Buffer.from(csv(day, 30)),
	});
	await expect(
		page.getByRole("status").filter({ hasText: "30 行を取り込んだ" }),
	).toBeVisible();

	const jst = new Date(day + 9 * 3600_000).toISOString().slice(0, 10);
	await page.getByLabel("開始").fill(jst);
	await page.getByLabel("終了").fill(jst);
	const download = page.waitForEvent("download");
	await page.getByRole("button", { name: "1分足を CSV で書き出す" }).click();
	const file = await download;
	const ymd = jst.replaceAll("-", "");
	expect(file.suggestedFilename()).toBe(`btcjpy-1m-${ymd}-${ymd}.csv`);
	const text = (await (await file.createReadStream()).toArray()).join("");
	const lines = text.trimEnd().split("\n");
	expect(lines[0]).toBe("日時,始値,高値,安値,終値,出来高");
	expect(lines).toHaveLength(31);
	expect(lines[1]).toBe(
		`${jst}T09:00:00.000+09:00,13000000,13010000,12990000,13000000,0.5`,
	);
});
