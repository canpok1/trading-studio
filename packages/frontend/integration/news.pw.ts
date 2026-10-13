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
