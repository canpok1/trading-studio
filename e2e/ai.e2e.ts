import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

// e2e/server.ts の DB と同じ場所。このファイルがあると偽物の AI が失敗する
const scoringDown = fileURLToPath(
	new URL("../.e2e-data/scoring-down", import.meta.url),
);

const DEFAULT_RULE = {
	halfLifeHours: { short: 6, medium: 24, long: 72 },
	thresholds: {
		risk: { mild: 20, alert: 40, severe: 55, crisis: 70 },
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
	// 重み・持続は閉じたままでも見える。版・モデルは「詳しく」で開く
	await expect(scored).toContainText(/重み \d+%/);
	await expect(scored).toContainText(/センチ -?\d+/);
	await expect(scored).toContainText("持続 短期");
	await expect(scored).not.toContainText("プロンプト v");
	await scored.getByRole("button", { name: /詳しく/ }).click();
	await expect(scored).toContainText("プロンプト v");
	await expect(page.getByTestId("judge-sentiment")).toContainText(
		/\d+点 · \d+件から算出/,
	);
	await expect(
		page.getByRole("list", { name: "センチメントの色の意味" }),
	).toHaveText(/かなり弱気.*やや弱気.*中立.*やや強気.*かなり強気/);
	await expect(page.getByRole("list", { name: "リスクの色の意味" })).toHaveText(
		/平常.*やや警戒.*警戒.*かなり警戒.*危機/,
	);
});

test("採点した記事に、値動きを測るまでは精度の測定中を出す", async ({
	page,
}) => {
	await page.goto("/news");
	const scored = page
		.getByTestId("news-card")
		.filter({ hasText: "デモの採点。" })
		.first();
	await expect(scored).toBeVisible({ timeout: 20_000 });
	await expect(scored.getByTestId("article-precision")).toHaveText(
		"精度（24h） 測定中",
	);
	await expect(page.getByTestId("judge-sentiment")).not.toContainText("精度");
});

test("評価詳細のタブに、市場評価に使った記事の段階ごとの件数・平均点・重みの割合を出す", async ({
	page,
}) => {
	await page.goto("/news");
	await expect(
		page.getByTestId("news-card").filter({ hasText: "デモの採点。" }).first(),
	).toBeVisible({ timeout: 20_000 });
	await page.getByRole("tab", { name: "評価詳細" }).click();
	await expect(page).toHaveURL(/tab=evaluation/);
	await expect(
		page.getByRole("heading", { name: "市場評価の内訳" }),
	).toBeVisible();
	const sentiment = page.getByTestId("breakdown-sentiment");
	await expect(sentiment.getByRole("row")).toHaveText([
		/記事の点数の段階.*件数.*平均点.*重みの割合/,
		/かなり強気\s*\d+件\s*(-?\d+点|—)\s*(\d+%|1%未満)/,
		/やや強気\s*\d+件/,
		/中立\s*\d+件/,
		/やや弱気\s*\d+件/,
		/かなり弱気\s*\d+件/,
	]);
	await expect(page.getByTestId("breakdown-risk").getByRole("row")).toHaveCount(
		6,
	);
	await expect(
		page.getByRole("heading", { name: "市場評価の分析" }),
	).toBeVisible();
	await expect(page.getByTestId("accuracy-summary-setting")).toHaveText(
		"直近30日・24h",
	);
	// デモの採点は値動きを測るまで測定中なので数えない
	const precision = page.getByTestId("accuracy-summary-sentiment");
	await expect(precision).toContainText("精度を出せた記事なし");
	await expect(precision.getByRole("button")).toHaveText([
		"0件",
		"0件",
		"0件",
		"0件",
		"0件",
	]);
	await expect(
		page.getByTestId("accuracy-summary-risk").getByRole("button"),
	).toHaveCount(5);
	await expect(
		page.getByRole("list", { name: "リスクの色の意味" }),
	).toHaveCount(1);
	await page.getByRole("tab", { name: "一覧" }).click();
	await expect(page).not.toHaveURL(/tab=/);
});

test("評価詳細の分析は、見せ方を切り替えて棒を押すと内訳を出す", async ({
	page,
}) => {
	// デモの採点は測定中なので、集計の応答を差し替えて棒を出す
	const levels = (values: string[], counts: number[]) =>
		values.map((value, i) => ({ value, count: counts[i] ?? 0 }));
	const S = ["+2", "+1", "0", "-1", "-2"];
	const R = ["calm", "mild", "alert", "severe", "crisis"];
	const rows = (values: string[], byPrecision: number[][]) =>
		[5, 4, 3, 2, 1].map((precision, i) => {
			const c = byPrecision[i] ?? [];
			return {
				precision,
				count: c.reduce((a, b) => a + b, 0),
				levels: levels(values, c),
			};
		});
	const matrix = (values: string[], moves: Record<string, number[]>) =>
		values.map((value) => ({ value, moves: moves[value] ?? [0, 0, 0, 0, 0] }));
	await page.route("**/api/scoring/accuracy/summary**", (r) =>
		r.fulfill({
			json: {
				horizon: "24h",
				periodDays: 30,
				time: Date.now(),
				filter: { criteriaVersion: null, appBuiltAt: null },
				options: {
					criteriaVersions: [],
					appBuiltAts: [],
					activeCriteriaVersion: 1,
				},
				results: {
					sentiment: {
						count: 6,
						average: 3.5,
						rows: rows(S, [[0, 1, 2], [], [0, 0, 1], [], [2]]),
						matrix: matrix(S, {
							"+2": [2, 0, 0, 0, 0],
							"+1": [0, 0, 0, 1, 0],
							"0": [0, 0, 2, 0, 1],
						}),
					},
					risk: {
						count: 0,
						average: null,
						rows: rows(R, []),
						matrix: matrix(R, {}),
					},
				},
			},
		}),
	);
	await page.goto("/news?tab=evaluation");
	const card = page.getByTestId("accuracy-summary-sentiment");
	await expect(card).toContainText("6件");
	await expect(
		card.getByRole("button", { name: "精度 高: 0件" }),
	).toBeDisabled();
	await card.getByRole("button", { name: "精度 最高: 3件" }).click();
	await expect(card.getByTestId("accuracy-summary-detail")).toHaveText(
		"精度 最高: やや強気 1件（33%） · 中立 2件（67%）",
	);
	await card.getByRole("button", { name: "精度 最高: 3件" }).click();
	await expect(card.getByTestId("accuracy-summary-detail")).toHaveCount(0);

	// 評価ごと: 横軸が記事の段階で、棒の中は精度
	const view = page.getByRole("group", { name: "見せ方" });
	await view.getByText("評価ごと", { exact: true }).click();
	await expect(card.getByRole("button")).toHaveText([
		"0件",
		"0件",
		"3件",
		"1件",
		"2件",
	]);
	await card.getByRole("button", { name: "中立: 3件" }).click();
	await expect(card.getByTestId("accuracy-summary-detail")).toHaveText(
		"中立: 精度 最高 2件（67%） · 精度 中 1件（33%）",
	);
	await expect(page.getByRole("list", { name: "精度の色の意味" })).toHaveCount(
		2,
	);

	// 評価×値動き: 行が記事の段階、列が値動き。割合は行ごと
	await view.getByText("評価×値動き", { exact: true }).click();
	const row = card.getByRole("row", { name: /^中立/ });
	await expect(row.getByRole("cell")).toHaveText([
		"0件",
		"0件",
		"2件",
		"0件",
		"1件",
	]);
	await page
		.getByRole("group", { name: "件数か割合か" })
		.getByText("割合", { exact: true })
		.click();
	await expect(row.getByRole("cell")).toHaveText([
		"0%",
		"0%",
		"67%",
		"0%",
		"33%",
	]);
	await expect(
		card.getByRole("row", { name: /^やや弱気/ }).getByRole("cell"),
	).toHaveText(["—", "—", "—", "—", "—"]);
	// 見せ方はブラウザに保存する
	await page.reload();
	await expect(
		card.getByRole("row", { name: /^中立/ }).getByRole("cell"),
	).toHaveText(["0%", "0%", "67%", "0%", "33%"]);
});

test("評価詳細の分析は、プロンプトとサーバーの版で絞り込み、URL に持つ", async ({
	page,
}) => {
	const built = Date.parse("2026-10-07T12:05:00Z");
	const asked: URLSearchParams[] = [];
	await page.route("**/api/scoring/accuracy/summary**", (r) => {
		const q = new URL(r.request().url()).searchParams;
		asked.push(q);
		const cv = q.get("criteriaVersion");
		const app = q.get("appBuiltAt");
		const empty = {
			count: 0,
			average: null,
			rows: [],
			matrix: [],
		};
		return r.fulfill({
			json: {
				horizon: "24h",
				periodDays: 30,
				time: Date.now(),
				filter: {
					criteriaVersion: cv ? Number(cv) : null,
					appBuiltAt: app === "none" ? "none" : app ? Number(app) : null,
				},
				options: {
					criteriaVersions: [
						{ version: 3, count: 12 },
						{ version: 2, count: 40 },
					],
					appBuiltAts: [
						{ builtAt: built, count: 30 },
						{ builtAt: null, count: 22 },
					],
					activeCriteriaVersion: 3,
				},
				results: { sentiment: empty, risk: empty },
			},
		});
	});
	await page.goto("/news?tab=evaluation");
	const prompt = page.getByRole("combobox", { name: "プロンプト" });
	const server = page.getByRole("combobox", { name: "サーバー" });
	await expect(prompt.getByRole("option")).toHaveText([
		"すべて",
		"v3（12件）使用中",
		"v2（40件）",
	]);
	await expect(server.getByRole("option")).toHaveText([
		"すべて",
		"Ver 10-07 21:05（30件）",
		"Ver 記録なし（22件）",
	]);
	await prompt.selectOption({ label: "v2（40件）" });
	await server.selectOption({ label: "Ver 10-07 21:05（30件）" });
	await expect(page).toHaveURL(/prompt=2/);
	await expect(page).toHaveURL(new RegExp(`server=${built}`));
	await expect(page.getByTestId("accuracy-summary-setting")).toHaveText(
		"直近30日・24h・v2・Ver 10-07 21:05",
	);
	expect(asked.at(-1)?.get("criteriaVersion")).toBe("2");
	expect(asked.at(-1)?.get("appBuiltAt")).toBe(String(built));
	// 絞り込みは URL に持つので、開き直しても、一覧の絞り込みを変えても残る
	await page.reload();
	await expect(prompt).toHaveValue("2");
	await page.getByRole("tab", { name: "一覧" }).click();
	await page.getByRole("button", { name: "強気材料" }).click();
	await expect(page).toHaveURL(/impact=/);
	await page.getByRole("tab", { name: "評価詳細" }).click();
	await expect(prompt).toHaveValue("2");
	await prompt.selectOption({ label: "すべて" });
	await expect(page).not.toHaveURL(/prompt=/);
	await expect(page.getByTestId("accuracy-summary-setting")).toHaveText(
		"直近30日・24h・Ver 10-07 21:05",
	);
});

test("精度の測り方を設定すると、記事の精度と評価詳細の精度の条件が変わる", async ({
	page,
}) => {
	try {
		await page.goto("/settings?section=news&tab=accuracy");
		await page
			.getByRole("group", { name: "集計する期間" })
			.getByText("7日", { exact: true })
			.click();
		await page
			.getByRole("group", { name: "値動きを測る長さ" })
			.getByText("4時間後", { exact: true })
			.click();
		const rough = page.getByLabel("リスクの境目 24時間後 荒れた（以上）");
		await expect(rough).toHaveValue("2");
		await rough.fill("4");
		await expect(
			page.getByText("やや荒れ < 荒れた < かなり荒れ < 大荒れ"),
		).toBeVisible();
		await expect(page.getByRole("button", { name: "保存" })).toBeDisabled();
		await rough.fill("2");
		await page.getByRole("button", { name: "保存" }).click();
		await expect(page.getByRole("status")).toContainText("保存した");

		await page.goto("/news");
		await expect(page.getByTestId("article-precision").first()).toContainText(
			"精度（4h）",
			{ timeout: 20_000 },
		);
		await page.getByRole("tab", { name: "評価詳細" }).click();
		await expect(page.getByTestId("accuracy-summary-setting")).toHaveText(
			"直近7日・4h",
		);
	} finally {
		await page.request.put("/api/scoring/accuracy/settings", {
			data: {
				horizon: "24h",
				sentimentBands: {
					"4h": { small: 0.2, large: 0.7 },
					"24h": { small: 0.5, large: 2 },
				},
				riskBands: {
					"4h": { slight: 0.4, rough: 0.7, heavy: 1.1, wild: 1.8 },
					"24h": { slight: 1, rough: 2, heavy: 3, wild: 5 },
				},
				periodDays: 30,
			},
		});
	}
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

test("使用中の版で記事ごとに採点し直せる", async ({ page }, info) => {
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

	// 間違って押さないよう、ボタンは「詳しく」を開いたときだけ出す
	const rescore = page.getByRole("button", { name: `v${v} で採点し直す` });
	await expect(rescore).toHaveCount(0);
	const card = cards.first();
	await card.getByRole("button", { name: /詳しく/ }).click();
	await card.getByRole("button", { name: `v${v} で採点し直す` }).click();
	await expect(card).toContainText(`プロンプト v${v}`, { timeout: 20_000 });
	await expect(card).toContainText("採点し直し");
	await expect(
		card.getByRole("button", { name: `v${v} で採点し直す` }),
	).toHaveCount(0);
	// ほかの記事は採点し直さない
	const other = cards.nth(1);
	await other.getByRole("button", { name: /詳しく/ }).click();
	await expect(other).not.toContainText(`プロンプト v${v}`);
});
