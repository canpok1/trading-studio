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

test("取得して採点したニュースが一覧に出て、市場評価が表示される", async ({
	page,
}) => {
	await page.goto("/news");
	await expect(
		page.getByRole("heading", { name: "ニュース", level: 1 }),
	).toBeVisible();
	const scored = page
		.getByTestId("news-card")
		.filter({ hasText: "デモの採点。" })
		.first();
	await expect(scored).toBeVisible({ timeout: 20_000 });
	// 重みは閉じたままでも見える。版・モデルは「詳しく」で開く
	await expect(scored).toContainText(/重み \d+%/);
	await expect(scored).not.toContainText("プロンプト v");
	await scored.getByRole("button", { name: /詳しく/ }).click();
	await expect(scored).toContainText("プロンプト v");
	await expect(page.getByTestId("judge-sentiment")).toContainText(
		/\d+点 · \d+件から算出/,
	);
	await expect(
		page.getByRole("list", { name: "センチメントの色の意味" }),
	).toHaveText(/強い弱気.*やや弱気.*中立.*やや強気.*強い強気/);
	await expect(page.getByRole("list", { name: "リスクの色の意味" })).toHaveText(
		/平常.*警戒.*危機/,
	);
});

test("精度を一覧から開き、内訳を版ごとに出し、選んだ記事をプロンプトの試す記事にして開ける", async ({
	page,
}) => {
	await page.goto("/news");
	await expect(
		page.getByTestId("news-card").filter({ hasText: "デモの採点。" }).first(),
	).toBeVisible({ timeout: 20_000 });
	// 精度は開いたときに計算するので、採点の後に開き直す
	await page.reload();
	await page
		.getByTestId("judge-sentiment")
		.getByRole("link", { name: /精度/ })
		.click();
	await expect(page).toHaveURL(/tab=accuracy/);
	await expect(page.getByTestId("precision-sentiment")).toContainText(
		/データ不足|優秀|良い|普通|悪い/,
	);
	await expect(page.getByTestId("precision-sentiment")).toContainText("的中率");
	const card = page.getByRole("region", { name: "精度の内訳" });
	await expect(card).toContainText("戦略への影響");
	await expect(card).toContainText(/センチメント · v\d+（使用中） · \d+ 件/);
	await page.getByText("4時間後", { exact: true }).click();
	await expect(card).toContainText("的中（4時間後）");

	const res = await page.request.get("/api/news?limit=1");
	const { news } = (await res.json()) as { news: { id: number }[] };
	await page.goto(
		`/settings?section=news&tab=prompt&trial=${news[0]?.id ?? 0}`,
	);
	await expect(page.getByTestId("trial-targets")).toHaveText(
		"試す記事: 選んだ 1 件",
	);
});

test("評価ルールを保存すると市場評価が変わる", async ({ page }) => {
	try {
		await page.goto("/news");
		await expect(page.getByTestId("judge-sentiment")).toContainText(
			"件から算出",
			{
				timeout: 20_000,
			},
		);
		// 評価ルールはニュースの右上の「設定」から開く
		await page
			.getByRole("main")
			.getByRole("link", { name: "設定", exact: true })
			.click();
		await expect(page).toHaveURL(/\/settings\?section=news$/);
		// 偽物の AI のセンチメントは -40〜40 点なので、やや強気の下限を -40 点にすれば必ずやや強気になる。負の数も入れられる
		await page.getByLabel("中立", { exact: true }).fill("-41");
		await page.getByLabel("やや強気", { exact: true }).fill("-40");
		// 上限は上の範囲の下限から決まる
		await expect(page.getByText("〜 -41 点")).toBeVisible();
		await expect(page.getByTestId("rule-preview")).toContainText("やや強気");
		await page.getByRole("button", { name: "保存" }).click();
		await expect(
			page.getByRole("status").filter({ hasText: "保存した" }),
		).toBeVisible();
		await page.goto("/news");
		await expect(page.getByTestId("badge-sentiment").first()).toHaveText(
			/やや強気/,
		);

		await page.goto("/settings?section=news");
		await page.getByLabel("やや強気", { exact: true }).fill("-42");
		await expect(
			page.getByText("やや強気の下限（-42）以下にする"),
		).toBeVisible();
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
	const text = page.getByRole("textbox", { name: /採点の基準/ });
	await expect(text).not.toHaveValue("");
	await text.fill(`- E2E の基準 ${info.project.name}`);
	await page.getByRole("button", { name: "最新のニュースで試す" }).click();
	await expect(page.getByTestId("trial-result")).toContainText("デモの採点。");

	await page.getByRole("button", { name: "試す記事を選ぶ" }).click();
	const dialog = page.getByRole("dialog", { name: "試す記事を選ぶ" });
	await dialog.getByRole("checkbox").nth(0).check();
	await dialog.getByRole("checkbox").nth(1).check();
	await dialog.getByRole("button", { name: "2 件で決定" }).click();
	await expect(page.getByTestId("trial-targets")).toContainText("選んだ 2 件");
	await page.getByRole("button", { name: "選んだ記事で試す" }).click();
	await expect(page.getByTestId("trial-result")).toHaveCount(2);
	await expect(page.getByTestId("trial-result").first()).toContainText(
		"保存済みの採点",
	);

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
	const card = page
		.getByTestId("news-card")
		.filter({ hasText: `版 ${info.project.name}` })
		.filter({ hasText: "デモの採点。" })
		.first();
	await expect(card).toBeVisible({ timeout: 20_000 });
	await card.getByRole("button", { name: /詳しく/ }).click();
	await expect(card).toContainText(`プロンプト v${version}`);
});

test("取得元・取得間隔・採点のモデルの変更が保存される", async ({
	page,
}, info) => {
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

	await page.getByLabel("取得間隔（分）").fill("30");
	await page.getByRole("button", { name: "保存" }).first().click();
	await expect(page.getByText("取得間隔を保存した")).toBeVisible();

	await page.reload();
	await expect(page.getByLabel("取得間隔（分）")).toHaveValue("30");

	await row.getByRole("button", { name: /削除/ }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "削除する" })
		.click();
	await expect(row).toBeHidden();
	await page.request.put("/api/news/settings", {
		data: { intervalMinutes: 15 },
	});

	// 採点に使うモデルはプロンプトのタブ（先頭のカード）にある
	await page.goto("/settings?section=news&tab=prompt");
	const model = page.getByLabel("採点に使うモデル", { exact: true });
	await model.selectOption("gemini-3.8-flash");
	await page.getByRole("button", { name: "保存", exact: true }).first().click();
	await expect(page.getByText("モデルを保存した")).toBeVisible();
	await page.reload();
	await expect(model).toHaveValue("gemini-3.8-flash");
	await page.request.put("/api/scoring/model", {
		data: { model: "gemini-3.5-flash-lite" },
	});
});

test("API キーは保存・上書き・削除でき、保存したキーは画面に出ない", async ({
	page,
}) => {
	await page.goto("/settings");
	const state = page.getByTestId("api-key-state");
	const input = page.getByLabel("Gemini の API キー", { exact: true });
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

test("ニュースをキーワード・影響の大きさ・日付で絞り込める", async ({
	page,
}, info) => {
	const name = `filter-${info.project.name}`;
	await addSource(page, name);
	await page.goto("/news");
	await page.getByLabel("キーワード").fill(name);
	await expect(page).toHaveURL(new RegExp(`q=${name}`));
	await expect(page.getByText(/条件に当てはまる [1-9]\d* 件/)).toBeVisible({
		timeout: 20_000,
	});
	for (const card of await page.getByTestId("news-card").all()) {
		await expect(card).toContainText(name);
	}

	await page.getByRole("button", { name: "強気材料" }).click();
	await expect(page).toHaveURL(/impact=bull/);
	await expect(page.getByRole("button", { name: "強気材料" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);

	// 昨日までに絞ると、市場評価もその時点になる
	await page.getByRole("button", { name: /絞り込み/ }).click();
	const dialog = page.getByRole("dialog", { name: "絞り込み" });
	await dialog.getByText("日付を指定").click();
	const yesterday = new Date(Date.now() + 9 * 3_600_000 - 86_400_000)
		.toISOString()
		.slice(0, 10);
	await dialog.getByLabel("終了日").fill(yesterday);
	await dialog.getByRole("button", { name: "この条件で見る" }).click();
	await expect(page).toHaveURL(new RegExp(`period=custom&to=${yesterday}`));
	await expect(
		page.getByRole("heading", { name: "過去の時点の市場評価" }),
	).toBeVisible();
	// 条件のチップが増えても横にはみ出さない（横にスクロールする）
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth > window.innerWidth,
		),
	).toBe(false);

	await page.getByRole("button", { name: /絞り込み/ }).click();
	await dialog.getByRole("button", { name: "条件をクリア" }).click();
	await dialog.getByRole("button", { name: "この条件で見る" }).click();
	await expect(
		page.getByRole("heading", { name: "今の市場評価" }),
	).toBeVisible();
	await expect(page).toHaveURL(new RegExp(`/news\\?q=${name}$`));
});

test("使用中の版で1件ずつ・絞り込んだものをまとめて採点し直せる", async ({
	page,
}, info) => {
	// 取得・採点・採点し直しを順に待つので長めにとる
	test.setTimeout(90_000);
	const name = `replace-score-${info.project.name}`;
	await addSource(page, name);
	await page.goto(`/news?q=${name}`);
	const cards = page
		.getByTestId("news-card")
		.filter({ hasText: "デモの採点。" });
	await expect(cards).toHaveCount(3, { timeout: 20_000 });

	// 新しい版を使用中にする
	const added = await page.request.post("/api/scoring/criteria", {
		data: { text: `- 採点し直しの基準 ${info.project.name}`, note: "E2E" },
	});
	const { version } = (await added.json()) as { version: { version: number } };
	const v = version.version;
	expect(
		(
			await page.request.put("/api/scoring/criteria/active", {
				data: { version: v },
			})
		).ok(),
	).toBe(true);

	const card = cards.first();
	await card.getByRole("button", { name: /詳しく/ }).click();
	await card.getByRole("button", { name: `v${v} で採点し直す` }).click();
	await expect(card).toContainText(`プロンプト v${v}`, { timeout: 20_000 });
	await expect(card).toContainText("採点し直し");

	await page.getByRole("button", { name: "この 3 件を採点し直す" }).click();
	const dialog = page.getByRole("dialog", { name: "まとめて採点し直す" });
	await dialog.getByRole("button", { name: "採点し直す" }).click();
	await expect(
		page.getByRole("status").filter({ hasText: `2 件を v${v} で採点し直す` }),
	).toBeVisible();
	for (const c of (await cards.all()).slice(1)) {
		await c.getByRole("button", { name: /詳しく/ }).click();
		await expect(c).toContainText(`プロンプト v${v}`, { timeout: 20_000 });
	}
});
