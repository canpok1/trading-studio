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
	frequency: {
		flat: { value: 1, unit: "h" },
		holding: { value: 1, unit: "h" },
	},
	orderSize: 1_000_000,
	dailyLossLimit: 30_000,
	stopLossCooldownBars: 0,
	buy: {
		match: "all",
		conditions: [
			{ type: "breakout", timeframe: "1h", lookback: 5, direction: "high" },
		],
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
	params: Record<string, unknown> = PARAMS,
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
	await page.getByRole("button", { name: "条件を読み込む" }).click();
	const dialog = page.getByRole("dialog", { name: "条件を読み込む" });
	await dialog.getByRole("button", { name: strategy }).click();
	await expect(dialog).toBeHidden();
	// 条件を読み込んでも名前は変わらないので、読み込み元と同じ名前を付ける
	await page.getByLabel("バックテスト名").fill(strategy);
	await page.getByLabel("開始").fill(from);
	await page.getByLabel("終了").fill(to);
}

test("ひな形から名前を付けて実行すると結果が出て、注文の詳細が見られ、条件を新しい戦略に保存できる", async ({
	page,
	request,
}, info) => {
	const name = `BT ${info.project.name}`;
	await prepare(request, name);
	await choose(page, name, "2026-05-03", "2026-05-25");
	const runName = page.getByLabel("バックテスト名");
	const title = `${name} 試し`;
	await runName.fill(title);
	await expect(page.getByText("1時間足 552 本")).toBeVisible();
	// 条件の足を変えると、使う足と本数も変わる
	await page.getByLabel("条件の足").first().selectOption({ label: "4時間足" });
	await expect(page.getByText("4時間足 138 本")).toBeVisible();
	await expect(page.getByText(`${name}（変更あり）`)).toBeVisible();
	// 条件を読み込み直すと条件は戻り、バックテスト名は変わらない
	await page.getByRole("button", { name: "条件を読み込む" }).click();
	await page
		.getByRole("dialog", { name: "条件を読み込む" })
		.getByRole("button", { name })
		.click();
	await expect(page.getByText("1時間足 552 本")).toBeVisible();
	await expect(runName).toHaveValue(title);
	// 読み込んだ条件から変えて試す
	await page.getByRole("button", { name: "0.001 増やす" }).click();
	await expect(page.getByText(`${name}（変更あり）`)).toBeVisible();
	await page.getByRole("button", { name: "バックテストを実行" }).click();

	await expect(page).toHaveURL(/\/backtest\/runs\/\d+$/);
	await expect(page.getByText(title, { exact: true })).toBeVisible();
	await expect(page.getByText(/1時間足で判定/)).toBeVisible();
	const summary = page.getByRole("region", { name: "成績の要約" });
	await expect(summary).toContainText("損益");
	await expect(summary).toContainText("取引回数");
	// 最大DD の評価は取引が無くても出る
	await expect(summary.getByTestId("grade-badge").first()).toBeVisible();
	await expect(page.getByRole("img", { name: "価格チャート" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "ローソク足", exact: true }),
	).toBeEnabled();

	// 一覧から売りの約定を開き、対応する買いへ移る
	const orders = page.getByRole("region", { name: "注文と約定" });
	await orders.getByRole("button", { name: /^売 / }).first().click();
	const sheet = page.getByRole("dialog", { name: "注文の詳細" });
	await expect(sheet).toContainText("戦略の理由");
	await expect(sheet).toContainText("売り · 約定");
	// どちらの条件で売ったかと条件の名前のバッジ
	await expect(sheet.getByTestId("exit-badge")).toHaveText(
		/^(利確: \+1%|損切り: −1%)$/,
	);
	await sheet.getByRole("button", { name: "対応する買いを見る" }).click();
	await expect(sheet).toContainText("買い · 約定");
	await sheet.getByRole("button", { name: "閉じる" }).click();

	// 新しい戦略として保存する
	await page.getByRole("button", { name: "新しい戦略として保存" }).click();
	const save = page.getByRole("dialog", { name: "新しい戦略として保存する" });
	await expect(save.getByLabel("戦略の名前")).toHaveValue(title);
	const saved = `${name} 結果`;
	await save.getByLabel("戦略の名前").fill(saved);
	await save.getByRole("button", { name: "保存", exact: true }).click();
	await expect(
		page.getByText(`「${saved}」として戦略に保存した`),
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
	// 取り込み済みの範囲の帯に、色の意味を添える
	const legend = page.getByRole("list").filter({ hasText: "選んだ期間" });
	await expect(legend).toContainText("取り込み済み");
	await expect(legend).toContainText("欠損（足が無い）");
	await page.getByRole("button", { name: "バックテストを実行" }).click();
	const alert = page.getByRole("alert");
	await expect(alert).toContainText("期間内にデータの欠損がある");
	await expect(alert).toContainText("合計 3 本");
	await alert.getByRole("button", { name: "欠損を飛ばして実行" }).click();
	await expect(page).toHaveURL(/\/backtest\/runs\/\d+$/);
	await expect(page.getByText(/欠損を飛ばして実行/)).toBeVisible();

	// 結果から「← 履歴」で履歴のタブへ戻り、過去の実行に並ぶ
	await page.getByRole("link", { name: "← 履歴" }).click();
	await expect(page).toHaveURL(/\/backtest\?tab=history$/);
	await expect(
		page.getByRole("tab", { name: "履歴", selected: true }),
	).toBeVisible();
	const history = page.getByRole("region", { name: "過去の実行" });
	await expect(history.getByRole("link").first()).toContainText(name);
	// 履歴のタブに実行の画面は出さず、「実行」のタブへ戻せる
	await expect(
		page.getByRole("button", { name: "バックテストを実行" }),
	).toHaveCount(0);
	await page.getByRole("tab", { name: "実行" }).click();
	await expect(page).toHaveURL(/\/backtest$/);
	await expect(history).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "バックテストを実行" }),
	).toBeVisible();

	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - window.innerWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
});

test("判定の間隔より細かいデータが無いと、実行前と結果で知らせる", async ({
	page,
	request,
}, info) => {
	const name = `BT 頻度 ${info.project.name}`;
	// 1時間足しか無いのに、保有中は15分ごとに判定する
	await prepare(request, name, {
		...PARAMS,
		frequency: { ...PARAMS.frequency, holding: { value: 15, unit: "m" } },
	});
	await choose(page, name, "2026-05-03", "2026-05-25");
	const notice = page.getByText(
		"判定の間隔より細かい過去データが無いため、1時間足の終わりごとにしか判定しない",
		{ exact: false },
	);
	await expect(notice).toBeVisible();
	await page.getByRole("button", { name: "バックテストを実行" }).click();
	await expect(page).toHaveURL(/\/backtest\/runs\/\d+$/);
	await expect(notice).toBeVisible();
});

test("市場評価の条件がある戦略は、採点の記録が始まる前の期間では実行できず理由が出る", async ({
	page,
	request,
}, info) => {
	const name = `BT 判定 ${info.project.name}`;
	await prepare(request, name, {
		...PARAMS,
		buy: {
			match: "all",
			conditions: [
				{ type: "judgment", judge: "sentiment", values: ["+2", "+1"] },
			],
		},
	});
	await choose(page, name, "2026-05-03", "2026-05-25");
	await expect(page.getByText(/市場評価の履歴を使う/)).toBeVisible();
	await expect(page.getByRole("alert")).toContainText(
		/市場評価の(記録は .+ から|条件があるが、ニュースの採点の記録がまだ無い)/,
	);
	await expect(
		page.getByRole("button", { name: "バックテストを実行" }),
	).toBeDisabled();
});

test("市場評価の条件で「データなし」を選ぶと、採点の記録が始まる前の期間でも実行できる", async ({
	page,
	request,
}, info) => {
	const name = `BT データなし ${info.project.name}`;
	await prepare(request, name, {
		...PARAMS,
		buy: {
			match: "all",
			conditions: [
				{ type: "judgment", judge: "sentiment", values: ["+1", "none"] },
			],
		},
	});
	await choose(page, name, "2026-05-03", "2026-05-25");
	await expect(page.getByText(/市場評価の履歴を使う/)).toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "バックテストを実行" }),
	).toBeEnabled();
});

test("結果画面でボタンを押すと AI アドバイスができ、作り直せる", async ({
	page,
	request,
}, info) => {
	const name = `助言 ${info.project.name}`;
	await prepare(request, name);
	await choose(page, name, "2026-05-03", "2026-05-10");
	await page.getByRole("button", { name: "バックテストを実行" }).click();
	await expect(page).toHaveURL(/\/backtest\/runs\/\d+$/);

	const advice = page.getByRole("region", { name: "AI アドバイス" });
	await advice.getByRole("button", { name: "アドバイスを作る" }).click();
	const content = advice.getByTestId("advice-content");
	await expect(content).toContainText(/デモの分析。注文は \d+ 件。/);
	await expect(content).toContainText("改善案");
	await expect(content).toContainText("指示 v");

	// 画面を開き直しても残り、作り直せる
	await page.reload();
	await expect(content).toContainText("デモの分析");
	await advice.getByRole("button", { name: "作り直す" }).click();
	await expect(advice.getByRole("button", { name: "作り直す" })).toBeEnabled();
	await expect(content).toContainText("デモの分析");

	// 改善版でバックテストすると、期間はそのまま、改善版の戦略と変更点が入った実行画面へ移る
	await advice
		.getByRole("button", { name: "改善版でバックテストする" })
		.click();
	await expect(page).toHaveURL(/\/backtest$/);
	await expect(page.getByLabel("バックテスト名")).toHaveValue(
		`${name}（改善版）`,
	);
	await expect(page.getByLabel("開始")).toHaveValue("2026-05-03");
	await expect(page.getByLabel("終了")).toHaveValue("2026-05-10");
	const changes = page.getByRole("region", { name: "AI の改善版の変更点" });
	await expect(changes).toContainText(
		"変更前: 終値が直近 5 本の最高値を上抜けた",
	);
	await expect(changes).toContainText(
		"変更後: 短期EMA 12 本が 長期EMA 48 本を上抜けた",
	);
	await changes.getByRole("button", { name: "閉じる" }).click();
	await expect(changes).toBeHidden();
});

test("別の AI の答えを貼ると、アドバイスとして取り込める", async ({
	page,
	request,
}, info) => {
	const name = `外の助言 ${info.project.name}`;
	await prepare(request, name);
	await choose(page, name, "2026-05-03", "2026-05-10");
	await page.getByRole("button", { name: "バックテストを実行" }).click();
	await expect(page).toHaveURL(/\/backtest\/runs\/\d+$/);

	const advice = page.getByRole("region", { name: "AI アドバイス" });
	await advice.getByRole("button", { name: "別の AI で作る" }).click();
	const dialog = page.getByRole("dialog", { name: "別の AI で作る" });
	await expect(dialog.getByText(/指示 v\d+（[\d,]+ 文字）/)).toBeVisible();
	const download = page.waitForEvent("download");
	await dialog.getByRole("button", { name: "資料をダウンロード" }).click();
	expect((await download).suggestedFilename()).toMatch(/^backtest-\d+\.md$/);

	await dialog.getByLabel("返ってきた答え").fill("答えではない");
	await dialog.getByRole("button", { name: "取り込む" }).click();
	await expect(dialog.getByRole("alert")).toContainText("JSON が無い");

	await dialog.getByLabel("返ってきた答え").fill(
		`\`\`\`json\n${JSON.stringify({
			analysis: "外の AI の分析",
			good: "- 良い",
			bad: "- 悪い",
			improvements: "- 変える",
			improvedStrategy: null,
		})}\n\`\`\``,
	);
	await dialog.getByLabel("使った AI の名前（任意）").fill("ChatGPT");
	await dialog.getByRole("button", { name: "取り込む" }).click();
	await expect(dialog).toBeHidden();
	const content = advice.getByTestId("advice-content");
	await expect(content).toContainText("外の AI の分析");
	await expect(content).toContainText("ChatGPT");
	await expect(content).toContainText("AI の応答に改善版の戦略が無い");
});

test("設定の「バックテスト」でアドバイスのモデルと指示の版を変えられる", async ({
	page,
}, info) => {
	await page.goto("/settings?section=backtest");
	await page
		.getByLabel("アドバイスに使うモデル", { exact: true })
		.selectOption("gemini-3.1-pro-preview");
	await page.getByRole("button", { name: "保存" }).first().click();
	await expect(page.getByText("モデルを保存した")).toBeVisible();

	await page.getByLabel(/^指示/).fill(`- E2E の指示 ${info.project.name}`);
	await page.getByRole("button", { name: /として保存/ }).click();
	const saved = page.getByRole("status").filter({ hasText: /v\d+ を保存した/ });
	await expect(saved).toBeVisible();
	const version = Number(
		(/v(\d+)/.exec((await saved.textContent()) ?? "") ?? [])[1],
	);
	await page
		.getByTestId(`instructions-v${version}`)
		.getByRole("button", { name: "使用する" })
		.click();
	await expect(page.getByTestId(`instructions-v${version}`)).toContainText(
		"使用中",
	);

	await page.reload();
	await expect(
		page.getByLabel("アドバイスに使うモデル", { exact: true }),
	).toHaveValue("gemini-3.1-pro-preview");
	await page.request.put("/api/advice/model", {
		data: { model: "gemini-3.8-flash" },
	});
});

test("RSI の条件を持つ戦略の結果では、チャートの下に RSI の小窓と値が出る", async ({
	page,
	request,
}, info) => {
	const name = `BT RSI ${info.project.name}`;
	await prepare(request, name, {
		...PARAMS,
		buy: {
			match: "all",
			conditions: [
				{
					type: "rsi",
					timeframe: "1h",
					period: 14,
					threshold: 30,
					direction: "below",
				},
			],
		},
		takeProfit: {
			match: "any",
			conditions: [
				{
					type: "rsi",
					timeframe: "1h",
					period: 14,
					threshold: 70,
					direction: "above",
				},
			],
		},
	});
	await choose(page, name, "2026-05-03", "2026-05-10");
	await page.getByRole("button", { name: "バックテストを実行" }).click();
	await expect(page).toHaveURL(/\/backtest\/runs\/\d+$/);
	// 既定の日足では期間（7日）が指標の本数に足りないので、条件の足に合わせる
	await page.getByLabel("足の粒度").selectOption("1h");
	const toggle = page.getByRole("button", { name: "RSI", exact: true });
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("chart-rsi-14")).toHaveText(/^RSI14 \d+\.\d$/);
	await page.getByText("凡例").click();
	await expect(page.getByText(/点線はしきい値/)).toBeVisible();
});

test("ボリンジャーバンドの条件を持つ戦略の結果では、チャートにバンドと値が出る", async ({
	page,
	request,
}, info) => {
	const name = `BT BB ${info.project.name}`;
	await prepare(request, name, {
		...PARAMS,
		buy: {
			match: "all",
			conditions: [
				{
					type: "bollinger",
					timeframe: "1h",
					period: 20,
					sigma: 2,
					band: "lower",
				},
			],
		},
	});
	await choose(page, name, "2026-05-03", "2026-05-10");
	await page.getByRole("button", { name: "バックテストを実行" }).click();
	await expect(page).toHaveURL(/\/backtest\/runs\/\d+$/);
	// 既定の日足では期間（7日）が指標の本数に足りないので、条件の足に合わせる
	await page.getByLabel("足の粒度").selectOption("1h");
	const toggle = page.getByRole("button", { name: "BB", exact: true });
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("chart-bb")).toHaveText(
		/^BB20 [\d,]+\/[\d,]+\/[\d,]+$/,
	);
	await page.getByText("凡例").click();
	await expect(page.getByText(/本数と σ は戦略の条件の値/)).toBeVisible();
});

test("採点の版を選ぶと、足りない記事をその版で採点し直してから実行でき、結果に版が出る", async ({
	page,
	request,
}, info) => {
	// ほかのテストが足した取得元の記事も採点し直すので長めに待つ
	test.setTimeout(180_000);
	// 採点し直しは運用で採点済みの記事が対象なので、今の時刻のニュースと足を用意する
	const src = await request.post("/api/news/sources", {
		data: {
			name: `版 ${info.project.name}`,
			url: `https://e2e.example/rescore-${info.project.name}`,
			language: "ja",
		},
	});
	expect(src.ok()).toBe(true);
	// 足した取得元の記事（偽物の取得元は3件返す）が採点されるまで待つ。
	// 採点し直しを頼んだ後に採点された記事は、頼み直すまで対象に入らないため
	await expect
		.poll(
			async () =>
				(
					(await (
						await request.get(
							`/api/news?q=${encodeURIComponent(`rescore-${info.project.name}`)}`,
						)
					).json()) as { news: { score: { status: string } | null }[] }
				).news.filter((n) => n.score?.status === "done").length,
			{ timeout: 20_000 },
		)
		.toBe(3);
	const now = Date.now();
	const from = Math.floor(now / H) * H - 72 * H;
	const lines = ["日時,始値,高値,安値,終値,出来高"];
	for (let t = from; t < now - H; t += H) {
		lines.push(
			`${new Date(t).toISOString()},10000000,10010000,9990000,10000000,1`,
		);
	}
	const imp = await request.post("/api/data/imports", {
		multipart: {
			file: {
				name: "now.csv",
				mimeType: "text/csv",
				buffer: Buffer.from(lines.join("\n")),
			},
			timeframe: "1h",
		},
	});
	const { job } = (await imp.json()) as { job: { id: number } };
	await expect
		.poll(async () => {
			const j = (
				(await (await request.get(`/api/data/imports/${job.id}`)).json()) as {
					job: { status: string; phase: string };
				}
			).job;
			if (j.phase === "confirming") {
				await request.post(`/api/data/imports/${job.id}/resolve`, {
					data: { overwrite: false },
				});
			}
			return j.status;
		})
		.toBe("done");
	const name = `BT 版 ${info.project.name}`;
	const s = await request.post("/api/strategies", {
		data: {
			name,
			from: {
				params: {
					...PARAMS,
					buy: {
						match: "all",
						conditions: [
							{
								type: "judgment",
								judge: "sentiment",
								values: ["+2", "+1", "0", "none"],
							},
						],
					},
				},
			},
		},
	});
	expect(s.status()).toBe(201);
	const added = await request.post("/api/scoring/criteria", {
		data: { text: `基準 ${info.project.name}`, note: "E2E の改善" },
	});
	const version = ((await added.json()) as { version: { version: number } })
		.version.version;

	const day = (t: number) => new Date(t + 9 * H).toISOString().slice(0, 10);
	await choose(page, name, day(now - 24 * H), day(now));
	await page
		.getByLabel("採点の版", { exact: true })
		.selectOption(String(version));
	const alert = page.getByRole("alert").filter({ hasText: `v${version}` });
	await expect(alert).toContainText(/件に v\d+ の採点が無い/);
	const run = page.getByRole("button", { name: /の採点がそろうと実行できる/ });
	await expect(run).toBeDisabled();
	await alert.getByRole("button", { name: `v${version} で採点し直す` }).click();
	await expect(
		page.getByText(new RegExp(`v${version} の採点: (\\d+) / \\1 件`)),
	).toBeVisible({
		timeout: 150_000,
	});
	await page.getByRole("button", { name: "バックテストを実行" }).click();
	await expect(page).toHaveURL(/\/backtest\/runs\/\d+$/);
	await expect(page.getByRole("list", { name: "実行条件" })).toContainText(
		`採点の版 v${version}`,
	);
});
