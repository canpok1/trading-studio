import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const H = 3_600_000;
// JST 2026-05-01 00:00
const START = Date.UTC(2026, 3, 30, 15);
const DAYS = 40;
// 30日目の3本を欠かす
const GAP_AT = 30 * 24;

function csv(): string {
	const lines = ["日時,始値,高値,安値,終値,出来高"];
	for (let i = 0; i < DAYS * 24; i++) {
		if (i >= GAP_AT && i < GAP_AT + 3) continue;
		const t = START + i * H;
		// 2日周期で ±5% 動く。買いの指値が約定するよう、安値側のひげを長くする
		const close = Math.round(
			10_000_000 * (1 + 0.05 * Math.sin((2 * Math.PI * i) / 48)),
		);
		lines.push(
			`${new Date(t).toISOString()},${close},${close + 10_000},${close - 150_000},${close},1`,
		);
	}
	return lines.join("\n");
}

const PARAMS = {
	timeframe: "1h",
	frequency: {
		flat: { value: 1, unit: "h" },
		holding: { value: 1, unit: "h" },
	},
	orderSize: 1_000_000,
	buy: {
		match: "all",
		conditions: [{ type: "breakout", lookback: 5, direction: "high" }],
	},
	takeProfit: {
		match: "any",
		conditions: [{ type: "entryChange", percent: 1, direction: "up" }],
	},
	stopLoss: {
		match: "any",
		conditions: [{ type: "entryChange", percent: 1, direction: "down" }],
	},
};

async function prepare(
	request: APIRequestContext,
	name: string,
	params: typeof PARAMS = PARAMS,
) {
	const res = await request.post("/api/data/imports", {
		multipart: {
			file: {
				name: "bt.csv",
				mimeType: "text/csv",
				buffer: Buffer.from(csv()),
			},
			timeframe: "1h",
		},
	});
	expect(res.status()).toBe(202);
	const { job } = (await res.json()) as { job: { id: number } };
	// 前のテストで同じ足を取り込んでいれば重なりの確認になるので、上書きせずに進める
	await expect
		.poll(async () => {
			const r = await request.get(`/api/data/imports/${job.id}`);
			const j = ((await r.json()) as { job: { status: string; phase: string } })
				.job;
			if (j.phase === "confirming") {
				await request.post(`/api/data/imports/${job.id}/resolve`, {
					data: { overwrite: false },
				});
			}
			return j.status;
		})
		.toBe("done");
	const s = await request.post("/api/strategies", {
		data: { name, from: { params } },
	});
	expect(s.status()).toBe(201);
}

async function choose(page: Page, strategy: string, from: string, to: string) {
	await page.goto("/backtest");
	await page
		.getByLabel("戦略", { exact: true })
		.selectOption({ label: strategy });
	await page.getByLabel("開始").fill(from);
	await page.getByLabel("終了").fill(to);
}

test("戦略を選んで実行すると結果が出て、注文の詳細が見られ、条件を新しい戦略に保存できる", async ({
	page,
	request,
}, info) => {
	const name = `BT ${info.project.name}`;
	await prepare(request, name);
	await choose(page, name, "2026-05-03", "2026-05-25");
	await expect(page.getByText("1時間足（戦略の粒度） · 552 本")).toBeVisible();
	// 保存済みの条件から変えて試す
	await page.getByRole("button", { name: "0.001 増やす" }).click();
	await expect(
		page.getByText("保存済みの条件から変えて試している"),
	).toBeVisible();
	await page.getByRole("button", { name: "バックテストを実行" }).click();

	await expect(page).toHaveURL(/\/backtest\/runs\/\d+$/);
	const summary = page.getByRole("region", { name: "成績の要約" });
	await expect(summary).toContainText("損益");
	await expect(summary).toContainText("取引回数");
	await expect(page.getByRole("img", { name: "価格チャート" })).toBeVisible();

	// 一覧から売りの約定を開き、対応する買いへ移る
	const orders = page.getByRole("region", { name: "注文と約定" });
	await orders.getByRole("button", { name: /^売 / }).first().click();
	const sheet = page.getByRole("dialog", { name: "注文の詳細" });
	await expect(sheet).toContainText("戦略の理由");
	await expect(sheet).toContainText("売り · 約定");
	await sheet.getByRole("button", { name: "対応する買いを見る" }).click();
	await expect(sheet).toContainText("買い · 約定");
	await sheet.getByRole("button", { name: "閉じる" }).click();

	// 新しい戦略として保存する
	await page.getByRole("button", { name: "この条件を戦略に保存" }).click();
	const save = page.getByRole("dialog", { name: "この条件を戦略に保存する" });
	const saved = `${name} 結果`;
	await save.getByLabel("名前").fill(saved);
	await save.getByRole("button", { name: "新しい戦略として保存" }).click();
	await expect(
		page.getByText(`「${saved}」の保存済みの条件と同じ`),
	).toBeVisible();

	await page.goto("/strategies");
	await expect(
		page
			.getByLabel("戦略", { exact: true })
			.locator("option", { hasText: saved }),
	).toHaveCount(1);

	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - window.innerWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
});

test("期間に欠損があると確認が出て、飛ばして実行できる", async ({
	page,
	request,
}, info) => {
	const name = `BT 欠損 ${info.project.name}`;
	await prepare(request, name);
	await choose(page, name, "2026-05-25", "2026-06-05");
	await page.getByRole("button", { name: "バックテストを実行" }).click();
	const alert = page.getByRole("alert");
	await expect(alert).toContainText("期間内にデータの欠損がある");
	await expect(alert).toContainText("合計 3 本");
	await alert.getByRole("button", { name: "欠損を飛ばして実行" }).click();
	await expect(page).toHaveURL(/\/backtest\/runs\/\d+$/);
	await expect(page.getByText(/欠損を飛ばして実行/)).toBeVisible();

	// 過去の実行に並ぶ
	await page.goto("/backtest");
	await expect(
		page.getByRole("region", { name: "過去の実行" }).getByRole("link").first(),
	).toContainText(name);

	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - window.innerWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
});

test("判定頻度より細かいデータが無いと、実行前と結果で知らせる", async ({
	page,
	request,
}, info) => {
	const name = `BT 頻度 ${info.project.name}`;
	// 1時間足しか無いのに、ポジションありは15分ごとに判定する
	await prepare(request, name, {
		...PARAMS,
		frequency: { ...PARAMS.frequency, holding: { value: 15, unit: "m" } },
	});
	await choose(page, name, "2026-05-03", "2026-05-25");
	const notice = page.getByText(
		"判定頻度より細かい過去データが無いため、1時間足の終わりごとにしか判定しない",
		{ exact: false },
	);
	await expect(notice).toBeVisible();
	await page.getByRole("button", { name: "バックテストを実行" }).click();
	await expect(page).toHaveURL(/\/backtest\/runs\/\d+$/);
	await expect(notice).toBeVisible();
});
