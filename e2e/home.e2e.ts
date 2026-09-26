import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// e2e/server.ts の DB と同じ場所。このファイルがあると偽物の取引所が止まる
const downFile = fileURLToPath(
	new URL("../.e2e-data/feed-down", import.meta.url),
);

test("アプリを開くとホームが出て、現在値が自動で更新される", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page).toHaveURL(/\/home$/);
	const price = page.getByTestId("home-price");
	await expect(price).toHaveText(/^¥[\d,]+$/, { timeout: 15_000 });
	const first = await price.textContent();
	// 偽物の取引所は1秒ごとに価格を変える。画面は5秒ごとに問い合わせる
	await expect(price).not.toHaveText(first as string, { timeout: 15_000 });
	await expect(page.getByRole("img", { name: "価格チャート" })).toBeVisible();
});

test("収集が止まると現在値の下にエラーが出て、直ると消える", async ({
	page,
}) => {
	await page.goto("/home");
	await expect(page.getByTestId("home-price")).toHaveText(/^¥/, {
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

test("EMA の条件を持つ戦略を選ぶと EMA が出て、戦略の粒度以外では消える", async ({
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

	await select.selectOption({ label: `${trend}（1時間足）` });
	await expect(ema).toBeVisible();
	// 戦略の粒度（トレンド追随は1時間足）が選ばれている
	await expect(page.getByRole("radio", { name: "1時間" })).toBeChecked();

	await page.getByText("5分", { exact: true }).click();
	await expect(ema).toBeHidden();
	await expect(page.getByText(/EMA は戦略の粒度/)).toBeVisible();

	await select.selectOption({ label: `${range}（1時間足）` });
	await expect(ema).toBeHidden();
	await expect(page.getByText(/EMA は戦略の粒度/)).toBeHidden();

	// 選んだ戦略は保存される
	await page.reload();
	await expect(select.locator("option:checked")).toHaveText(
		new RegExp(`^${range}`),
	);
	await select.selectOption("");
});

test("ホームは横にはみ出さない", async ({ page }) => {
	await page.goto("/home");
	await expect(page.getByTestId("home-price")).toBeVisible();
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth > window.innerWidth,
	);
	expect(overflow).toBe(false);
});

test("チャートに AI 判定の背景と帯が出て、帯をタップすると背景が入れ替わり、再読み込み後も保たれる", async ({
	page,
}) => {
	// 足は1分ごとに閉じるので、採点が付いた後の足ができるまで待つことがある
	test.setTimeout(180_000);
	await page.goto("/home");
	await expect(page.getByTestId("home-judge-trend")).toContainText(/点|—/, {
		timeout: 20_000,
	});
	// 偽物の採点が付いた後に閉じた足ができるまで待つ
	await expect(async () => {
		await page.reload();
		await expect(page.getByTestId("chart-judgment-trend")).toBeVisible({
			timeout: 3_000,
		});
	}).toPass({ timeout: 120_000 });

	const group = page.getByRole("group", { name: "背景に使う判定" });
	await group.getByRole("button", { name: "トレンド" }).click();
	await expect(group.getByRole("button", { name: "トレンド" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	// 背景がトレンドのとき、帯は上からリスク・センチメント。上の帯（リスク）をタップする
	const chart = page.getByRole("img", { name: "価格チャート" });
	const box = await chart.boundingBox();
	if (!box) throw new Error("チャートが無い");
	// 下端から時間軸（約 26px）と帯の下側を除いた位置
	await chart.click({
		position: { x: box.width / 2, y: box.height - 26 - 27 },
	});
	await expect(group.getByRole("button", { name: "リスク" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await page.reload();
	await expect(
		page
			.getByRole("group", { name: "背景に使う判定" })
			.getByRole("button", { name: "リスク" }),
	).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
});
