import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

// e2e/server.ts の DB と同じ場所。このファイルがあると偽物の AI が失敗する
const scoringDown = fileURLToPath(
	new URL("../.e2e-data/scoring-down", import.meta.url),
);

const DEFAULT_RULE = {
	windowHours: 24,
	halfLifeHours: 6,
	thresholds: {
		trend: { up: 20, down: -20 },
		risk: { caution: 40, crisis: 70 },
		sentiment: { plus2: 60, plus1: 20, minus1: -20, minus2: -60 },
	},
};

/** 偽物の取得元を1つ足す。追加した取得元はすぐ取得される */
async function addSource(page: Page, name: string) {
	const res = await page.request.post("/api/news/sources", {
		data: {
			name,
			url: `https://e2e.example/${encodeURIComponent(name)}`,
			language: "ja",
		},
	});
	expect(res.ok()).toBe(true);
}

test("集めて採点したニュースが一覧に出て、判定が表示される", async ({
	page,
}) => {
	await page.goto("/news");
	await expect(
		page.getByRole("heading", { name: "ニュース", level: 1 }),
	).toBeVisible();
	const scored = page
		.getByTestId("news-card")
		.filter({ hasText: "プロンプト v" })
		.first();
	await expect(scored).toBeVisible({ timeout: 20_000 });
	await expect(scored).toContainText("デモの採点。");
	await expect(scored).toContainText(/重み \d+%/);
	await expect(page.getByTestId("judge-trend")).toContainText(
		/\d+点 · \d+件から算出/,
	);
});

test("集計ルールを保存すると判定が変わる", async ({ page }) => {
	try {
		await page.goto("/news");
		await expect(page.getByTestId("judge-trend")).toContainText("件から算出", {
			timeout: 20_000,
		});
		// 集計ルールはニュースの右上の「設定」から開く
		await page
			.getByRole("main")
			.getByRole("link", { name: "設定", exact: true })
			.click();
		await expect(page).toHaveURL(/\/settings\?section=news$/);
		// 偽物の AI のトレンドは -40〜40 点なので、上昇を -40 点以上にすれば必ず上昇になる。負の数も入れられる
		await page.getByLabel("下落").fill("-41");
		await page.getByLabel("上昇").fill("-40");
		await expect(page.getByTestId("rule-preview")).toContainText("上昇");
		await page.getByRole("button", { name: "保存" }).click();
		await expect(
			page.getByRole("status").filter({ hasText: "保存した" }),
		).toBeVisible();
		await page.goto("/news");
		await expect(page.getByTestId("badge-trend").first()).toHaveText(/上昇/);

		await page.goto("/settings?section=news");
		await page.getByLabel("上昇").fill("-41");
		await expect(page.getByText("上昇（-41）より小さくする")).toBeVisible();
		await expect(page.getByRole("button", { name: "保存" })).toBeDisabled();
	} finally {
		await page.request.put("/api/judgments/rule", {
			data: { rule: DEFAULT_RULE },
		});
	}
});

test("基準を版として保存して使用すると、次に採点するニュースから新しい版になる", async ({
	page,
}, info) => {
	await page.goto("/settings?section=news&tab=prompt");
	const text = page.getByLabel(/採点の基準/);
	await expect(text).not.toHaveValue("");
	await text.fill(`- E2E の基準 ${info.project.name}`);
	await page.getByRole("button", { name: "最新のニュースで試す" }).click();
	await expect(page.getByTestId("trial-result")).toContainText("デモの採点。");

	await page.getByRole("button", { name: /として保存/ }).click();
	const saved = page.getByRole("status").filter({ hasText: /v\d+ を保存した/ });
	await expect(saved).toBeVisible();
	const version = Number(
		(/v(\d+)/.exec((await saved.textContent()) ?? "") ?? [])[1],
	);
	await page
		.getByTestId(`criteria-v${version}`)
		.getByRole("button", { name: "使用する" })
		.click();
	await expect(page.getByTestId(`criteria-v${version}`)).toContainText(
		"使用中",
	);

	await addSource(page, `版 ${info.project.name}`);
	await page.goto("/news");
	await expect(
		page
			.getByTestId("news-card")
			.filter({ hasText: `版 ${info.project.name}` })
			.filter({ hasText: `プロンプト v${version}` })
			.first(),
	).toBeVisible({ timeout: 20_000 });
});

test("取得元・収集間隔・モデルの変更が保存される", async ({ page }, info) => {
	await page.goto("/settings?section=news&tab=sources");
	const name = `追加 ${info.project.name}`;
	await page.getByLabel("名前").fill(name);
	await page
		.getByLabel("RSS の URL")
		.fill(`https://e2e.example/add-${info.project.name}`);
	await page.getByRole("button", { name: "追加する" }).click();
	const row = page.getByTestId("news-source").filter({ hasText: name });
	await expect(row).toContainText("最後に取得", { timeout: 15_000 });
	await row.getByRole("switch").click();
	await expect(row.getByRole("switch")).toHaveAttribute(
		"aria-checked",
		"false",
	);

	await page.getByLabel("収集間隔（分）").fill("30");
	await page.getByRole("button", { name: "保存" }).first().click();
	await expect(page.getByText("収集間隔を保存した")).toBeVisible();

	await page.getByLabel("採点に使うモデル").selectOption("gemini-3.8-flash");
	await page.getByRole("button", { name: "保存" }).last().click();
	await expect(page.getByText("モデルを保存した")).toBeVisible();

	await page.reload();
	await expect(page.getByLabel("収集間隔（分）")).toHaveValue("30");
	await expect(page.getByLabel("採点に使うモデル")).toHaveValue(
		"gemini-3.8-flash",
	);

	await row.getByRole("button", { name: /削除/ }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "削除する" })
		.click();
	await expect(row).toBeHidden();
	await page.request.put("/api/news/settings", {
		data: { intervalMinutes: 15 },
	});
	await page.request.put("/api/scoring/model", {
		data: { model: "gemini-3.5-flash-lite" },
	});
});

test("API キーは保存・上書き・削除でき、保存したキーは画面に出ない", async ({
	page,
}) => {
	await page.goto("/settings");
	const state = page.getByTestId("api-key-state");
	const input = page.getByLabel("Gemini の API キー");
	await expect(state).toHaveText("未設定");
	await expect(input).toHaveAttribute("type", "password");
	// 入力欄と同じ行のボタン
	const submit = input.locator("..").getByRole("button");
	await input.fill("e2e-secret-1");
	await expect(submit).toHaveText("保存");
	await submit.click();
	await expect(page.getByText("API キーを保存した")).toBeVisible();
	await expect(state).toContainText("設定済み");
	await expect(input).toHaveValue("");

	await page.reload();
	await expect(state).toContainText("設定済み");
	await expect(input).toHaveValue("");
	await expect(page.locator("body")).not.toContainText("e2e-secret");
	await input.fill("e2e-secret-2");
	await expect(submit).toHaveText("上書き");
	await submit.click();
	await expect(page.getByText("API キーを保存した")).toBeVisible();

	await page.getByRole("button", { name: "キーを削除" }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "削除する" })
		.click();
	await expect(state).toHaveText("未設定");
	await expect(page.getByRole("button", { name: "キーを削除" })).toBeHidden();
});

test("採点に失敗したニュースを再試行できる", async ({ page }, info) => {
	const name = `失敗 ${info.project.name}`;
	writeFileSync(scoringDown, "");
	try {
		await addSource(page, name);
		await page.goto("/news");
		await expect(
			page
				.getByRole("alert")
				.filter({ hasText: "ニュースの採点が止まっている" }),
		).toBeVisible({ timeout: 20_000 });
		const failed = page
			.getByTestId("news-card")
			.filter({ hasText: name })
			.filter({ has: page.getByRole("button", { name: "再試行" }) })
			.first();
		// E2E では自動の再試行を1秒おきに3回で打ち切る
		await expect(failed).toBeVisible({ timeout: 30_000 });
	} finally {
		rmSync(scoringDown, { force: true });
	}
	const card = page.getByTestId("news-card").filter({ hasText: name }).first();
	await card.getByRole("button", { name: "再試行" }).click();
	await expect(card).toContainText("デモの採点。", { timeout: 20_000 });
});
