import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

// 入力欄を1つずつ空欄にしても画面が落ちないこと。
// 画面は検証前の入力途中の値（空欄は NaN）でも計算し、バックテストの下書きはブラウザに残るので、
// 落ちると開き直しても同じく落ち続ける

const H = 3_600_000;
const START = Date.UTC(2026, 3, 30, 15);

function csv(): string {
	const lines = ["日時,始値,高値,安値,終値,出来高"];
	for (let i = 0; i < 10 * 24; i++) {
		const close = 10_000_000 + (i % 48) * 10_000;
		lines.push(
			`${new Date(START + i * H).toISOString()},${close},${close},${close},${close},1`,
		);
	}
	return lines.join("\n");
}

const all = <T>(conditions: T[]) => ({ match: "all", conditions });
const any = <T>(conditions: T[]) => ({ match: "any", conditions });

// 条件の種類と注文の出し方をひととおり持つ戦略
const PARAMS = {
	frequency: {
		flat: { value: 1, unit: "h" },
		holding: { value: 15, unit: "m" },
	},
	dailyLossLimit: 30_000,
	stopLossCooldownBars: 2,
	stopLossCooldownTimeframe: "1h",
	buys: [
		{
			id: "b1",
			name: "買い1",
			orderSize: 1_000_000,
			maxPositions: 3,
			buy: all([
				{
					type: "emaCross",
					timeframe: "1h",
					fast: 9,
					slow: 21,
					direction: "up",
				},
				{ type: "breakout", timeframe: "1h", lookback: 5, direction: "high" },
				{
					type: "rsi",
					timeframe: "1h",
					period: 14,
					threshold: 30,
					direction: "below",
				},
				{
					type: "rsiCross",
					timeframe: "1h",
					period: 14,
					threshold: 30,
					bars: 3,
					direction: "up",
				},
				{
					type: "emaPosition",
					timeframe: "1h",
					period: 50,
					direction: "above",
				},
				{
					type: "emaSlope",
					timeframe: "1h",
					period: 20,
					bars: 3,
					percent: 0.5,
					direction: "up",
				},
				{
					type: "bollinger",
					timeframe: "1h",
					period: 20,
					sigma: 2,
					band: "lower",
				},
				{ type: "judgment", judge: "risk", values: ["calm", "none"] },
			]),
			buyOrder: {
				lines: [{ type: "market" }, { type: "limit", belowPercent: 0.5 }],
				expireBars: 3,
				expireTimeframe: "1h",
			},
			partialTakeProfit: any([
				{ type: "entryChange", percent: 2, direction: "up" },
			]),
			partialSell: { percent: 50, breakevenStop: true },
			takeProfit: any([
				{ type: "entryChange", percent: 4, direction: "up" },
				{ type: "trailingStop", percent: 2, activatePercent: 1 },
				{ type: "holdingBars", timeframe: "1h", bars: 48 },
			]),
			stopLoss: any([{ type: "entryChange", percent: 3, direction: "down" }]),
		},
	],
};

/** 入力欄を1つずつ空欄にし、そのたびに画面が出ていることを確かめる */
async function clearEachInput(page: Page, heading: string) {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	const title = page.getByRole("heading", { name: heading, exact: true });
	const inputs = page.locator('main input[type="text"]');
	const n = await inputs.count();
	expect(n).toBeGreaterThan(20);
	for (let i = 0; i < n; i++) {
		const input = inputs.nth(i);
		const label = (await input.getAttribute("aria-label")) ?? `${i} 番目`;
		if (await input.isEditable()) await input.fill("");
		await expect(title, `「${label}」を空欄にしたとき`).toBeVisible();
		expect(errors, `「${label}」を空欄にしたとき`).toEqual([]);
	}
}

test("バックテストの実行画面は、入力欄を空欄にしても、その下書きで開き直しても落ちない", async ({
	page,
	request,
}) => {
	const res = await request.post("/api/data/imports", {
		multipart: {
			file: {
				name: "robust.csv",
				mimeType: "text/csv",
				buffer: Buffer.from(csv()),
			},
			timeframe: "1h",
		},
	});
	expect(res.status()).toBe(202);
	const { job } = (await res.json()) as { job: { id: number } };
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

	await page.goto("/backtest");
	await expect(page.getByLabel("バックテスト名")).toBeVisible();
	await page.evaluate((params) => {
		const d = JSON.parse(localStorage.getItem("backtest-draft") ?? "{}");
		localStorage.setItem(
			"backtest-draft",
			JSON.stringify({ ...d, template: null, params }),
		);
	}, PARAMS);
	await page.reload();
	await expect(page.getByLabel("バックテスト名")).toBeVisible();

	await clearEachInput(page, "バックテスト");
	await page.reload();
	await expect(page.getByLabel("バックテスト名")).toBeVisible();
});

test("戦略の画面は、入力欄を空欄にしても落ちない", async ({
	page,
	request,
}, info) => {
	const name = `空欄 ${info.project.name}`;
	const res = await request.post("/api/strategies", {
		data: { name, from: { params: PARAMS } },
	});
	expect(res.status()).toBe(201);
	const { strategy } = (await res.json()) as { strategy: { id: number } };

	await page.goto(`/strategies/${strategy.id}`);
	await expect(page.getByLabel("戦略", { exact: true })).toHaveValue(
		String(strategy.id),
	);
	await clearEachInput(page, "戦略");
});
