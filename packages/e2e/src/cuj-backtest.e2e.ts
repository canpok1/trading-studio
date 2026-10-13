// CUJ 1: 戦略を作り、バックテストを流し、結果を見る
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "@playwright/test";

const H = 3_600_000;
// JST 2026-05-01 00:00 から 30 日分の 1時間足
const START = Date.UTC(2026, 3, 30, 15);
const HOURS = 30 * 24;

function csv(): string {
	const lines = ["日時,始値,高値,安値,終値,出来高"];
	for (let i = 0; i < HOURS; i++) {
		// 2日周期で ±5% 動かし、ひな形の EMA のクロスで売買が起きるようにする
		const close = Math.round(
			10_000_000 * (1 + 0.05 * Math.sin((2 * Math.PI * i) / 48)),
		);
		lines.push(
			`${new Date(START + i * H).toISOString()},${close},${close + 10_000},${close - 10_000},${close},1`,
		);
	}
	return lines.join("\n");
}

// 過去データの取り込みは CUJ の外なので API で済ませる
async function importPrices(request: APIRequestContext) {
	const res = await request.post("/api/data/imports", {
		multipart: {
			file: {
				name: "cuj.csv",
				mimeType: "text/csv",
				buffer: Buffer.from(csv()),
			},
			timeframe: "1h",
		},
	});
	expect(res.status()).toBe(202);
	const { job } = (await res.json()) as { job: { id: number } };
	// 同じシャードの別のテストが同じ足を取り込んでいれば重なりの確認になる。どちらの値でも流れは変わらないので上書きしない
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
}

test("戦略をひな形から作って保存し、バックテストを流して結果を見る", async ({
	page,
	request,
}, info) => {
	// スマホ幅と PC 幅で同じ DB を使うので、名前に project 名を入れる
	const name = `CUJ バックテスト ${info.project.name}`;
	await importPrices(request);

	// 戦略を作る
	await page.goto("/strategies");
	await page.getByRole("button", { name: "＋ 新しい戦略" }).click();
	const create = page.getByRole("dialog", { name: "新しい戦略" });
	await create.getByLabel("名前").fill(name);
	await create.getByRole("button", { name: /^トレンド追随/ }).click();
	await expect(page.getByRole("status")).toHaveText(`「${name}」を作った`);
	await page
		.getByRole("region", { name: "売り注文（損切り）する条件" })
		.getByLabel("買値からの %")
		.fill("3");
	await page.getByRole("button", { name: "保存", exact: true }).click();
	await expect(page.getByRole("status")).toHaveText("保存した");

	// バックテストを流す
	await page.goto("/backtest");
	await page.getByRole("button", { name: "条件を読み込む" }).click();
	const load = page.getByRole("dialog", { name: "条件を読み込む" });
	await load.getByRole("button", { name }).click();
	await expect(load).toBeHidden();
	await page.getByLabel("バックテスト名").fill(name);
	await page.getByLabel("開始").fill("2026-05-03");
	await page.getByLabel("終了").fill("2026-05-25");
	await page.getByRole("button", { name: "バックテストを実行" }).click();

	// 結果を見る
	await expect(page).toHaveURL(/\/backtest\/runs\/\d+$/);
	await expect(page.getByText(name, { exact: true })).toBeVisible();
	const summary = page.getByRole("region", { name: "成績の要約" });
	await expect(summary).toContainText("損益");
	await expect(summary).toContainText("取引回数");
	await expect(page.getByRole("img", { name: "価格チャート" })).toBeVisible();
	const orders = page.getByRole("region", { name: "注文と約定" });
	await orders.getByRole("button", { name: /^買 / }).first().click();
	await expect(page.getByRole("dialog", { name: "注文の詳細" })).toContainText(
		"買い · 約定",
	);
});
