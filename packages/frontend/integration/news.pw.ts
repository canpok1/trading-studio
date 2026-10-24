import { expect, test } from "./browser";
import { routes } from "./fake-api";
import {
	accuracySummary,
	currentJudgment,
	newsCollectorStatus,
	newsItem,
	newsScore,
	scorerStatus,
} from "./fixtures";

test("ニュースの絞り込みの条件のチップが増えても、画面は横にはみ出さない", async ({
	page,
	api,
}) => {
	const t = Date.now() - 2 * 86_400_000;
	const news = [
		newsItem({
			id: 1,
			title: "とても長い見出しの記事".repeat(4),
			publishedAt: t,
			score: newsScore({ scoredAt: t }),
		}),
	];
	api
		.on(routes.api.judgments.current, "$get", (req) =>
			currentJudgment(news, Number(req.query.get("at") ?? Date.now())),
		)
		.on(routes.api.news, "$get", () => ({ news, total: news.length }))
		.on(routes.api.news.status, "$get", () => newsCollectorStatus())
		.on(routes.api.scoring.status, "$get", () => scorerStatus())
		.on(routes.api.scoring.accuracy, "$get", () => ({
			horizon: "24h" as const,
			items: [],
		}))
		.on(routes.api.scoring.accuracy.summary, "$get", () => accuracySummary());
	const yesterday = new Date(Date.now() + 9 * 3_600_000 - 86_400_000)
		.toISOString()
		.slice(0, 10);
	await page.goto(
		`/news?period=custom&to=${yesterday}&impact=bull,bear,risk&active=1`,
	);
	await expect(
		page.getByRole("heading", { name: "過去の時点の市場評価" }),
	).toBeVisible();
	await expect(page.getByTestId("news-card")).toHaveCount(1);
	// 条件のチップの列は横にスクロールする
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth > window.innerWidth,
		),
	).toBe(false);
});

test("銘柄ごとの点数の行は、最長の点数と持続でも横にはみ出さず、チップの左端がそろう", async ({
	page,
	api,
}) => {
	const t = Date.now() - 3_600_000;
	const longest = {
		scores: { sentiment: -100, risk: 100 },
		duration: "medium" as const,
	};
	const news = [
		newsItem({
			id: 1,
			title: "記事",
			publishedAt: t,
			score: newsScore({
				scoredAt: t,
				...longest,
				instruments: {
					"coincheck:btc_jpy": longest,
					"coincheck:eth_jpy": longest,
					"coincheck:xrp_jpy": longest,
				},
			}),
		}),
	];
	api
		.on(routes.api.judgments.current, "$get", () =>
			currentJudgment(news, Date.now()),
		)
		.on(routes.api.news, "$get", () => ({ news, total: news.length }))
		.on(routes.api.news.status, "$get", () => newsCollectorStatus())
		.on(routes.api.scoring.status, "$get", () => scorerStatus())
		.on(routes.api.scoring.accuracy, "$get", () => ({
			horizon: "24h" as const,
			items: [],
		}))
		.on(routes.api.scoring.accuracy.summary, "$get", () => accuracySummary());
	await page.goto("/news");
	const rows = page.getByTestId("score-row");
	await expect(rows).toHaveCount(4);
	const lefts = await rows.evaluateAll((els) =>
		els.map((e) => {
			const chip = e.querySelector("[data-testid^=score-chip-]");
			return chip?.getBoundingClientRect().left;
		}),
	);
	expect(new Set(lefts).size).toBe(1);
	const tops = await rows.evaluateAll((els) =>
		els.map((e) => {
			const chips = [...e.children].slice(1);
			return new Set(chips.map((c) => c.getBoundingClientRect().top)).size;
		}),
	);
	// 1行に収まる
	expect(tops).toEqual([1, 1, 1, 1]);
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth > window.innerWidth,
		),
	).toBe(false);
});
