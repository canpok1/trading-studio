import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type {
	AccuracySummary,
	ArticleAccuracy,
	NewsItem,
	ScorerStatus,
} from "@trading-studio/backend";
import { changeValue, setupDom } from "../src/shared/lib/test-setup";
import type { FakeApi } from "./fake-api";
import { createFakeApi, routes } from "./fake-api";
import {
	accuracyResult,
	accuracySummary,
	currentJudgment,
	newsCollectorStatus,
	newsItem,
	newsScore,
	scorerStatus,
} from "./fixtures";
import { renderApp } from "./render-app";

setupDom();

afterEach(async () => {
	await new Promise((r) => setTimeout(r, 20));
	cleanup();
});
beforeEach(() => localStorage.clear());

const HOUR = 3_600_000;

/** 1時間前に公開して採点した記事 */
function scored(id: number, title: string, score = newsScore()): NewsItem {
	const t = Date.now() - HOUR;
	return newsItem({
		id,
		title,
		publishedAt: t,
		score: { ...score, scoredAt: t },
	});
}

/** ニュース画面が読む口。news は API の絞り込みを済ませた結果として返す */
function newsApi({
	news,
	scorer = scorerStatus(),
	accuracy = (n) => ({ id: n.id, status: "measuring" }),
	summary = accuracySummary(),
}: {
	news: () => NewsItem[];
	scorer?: ScorerStatus;
	accuracy?: (n: NewsItem) => ArticleAccuracy;
	summary?: AccuracySummary;
}): FakeApi {
	return createFakeApi()
		.on(routes.api.judgments.current, "$get", (req) => {
			const at = req.query.get("at");
			return currentJudgment(news(), at ? Number(at) : Date.now());
		})
		.on(routes.api.news, "$get", () => {
			const all = news();
			return { news: all, total: all.length };
		})
		.on(routes.api.news.status, "$get", () => newsCollectorStatus())
		.on(routes.api.scoring.status, "$get", () => scorer)
		.on(routes.api.scoring.accuracy, "$get", () => ({
			horizon: "24h" as const,
			items: news()
				.filter((n) => n.score?.status === "done")
				.map(accuracy),
		}))
		.on(routes.api.scoring.accuracy.summary, "$get", () => summary);
}

const cards = (view: ReturnType<typeof renderApp>) =>
	view.queryAllByTestId("news-card");

describe("一覧", () => {
	test("採点したニュースが重み・点数・持続とともに並び、版・モデルは「詳しく」で開く", async () => {
		const news = [
			scored(
				1,
				"記事 A",
				newsScore({
					scores: { sentiment: 30, risk: 10 },
					comment: "強気の理由。",
				}),
			),
		];
		const view = renderApp("/news", newsApi({ news: () => news }));
		const card = within(
			(await view.findAllByTestId("news-card"))[0] as HTMLElement,
		);
		expect(card.getByText("記事 A")).toBeTruthy();
		const text = () =>
			card.getByText("記事 A").closest("article")?.textContent ?? "";
		// 1時間前の短期（半減期 6 時間）なので重みは 0.5^(1/6)
		expect(text()).toContain("重み 89%");
		expect(text()).toContain("センチ 30");
		expect(text()).toContain("持続 短期");
		expect(text()).not.toContain("プロンプト v");
		fireEvent.click(card.getByRole("button", { name: /詳しく/ }));
		expect(text()).toContain("プロンプト v1 · gemini-3.5-flash-lite");

		const judge = view.getByTestId("judge-sentiment");
		expect(judge.textContent).toContain("30点 · 1件から算出");
		expect(
			view.getByRole("list", { name: "センチメントの色の意味" }).textContent,
		).toMatch(/かなり弱気.*やや弱気.*中立.*やや強気.*かなり強気/);
		expect(
			view.getByRole("list", { name: "リスクの色の意味" }).textContent,
		).toMatch(/平常.*やや警戒.*警戒.*かなり警戒.*危機/);
	});

	test("個別に関係する銘柄の点数がある記事は、市場全体の点数と銘柄ごとの点数を行に分けて出す", async () => {
		const news = [
			scored(
				1,
				"記事 A",
				newsScore({
					scores: { sentiment: 10, risk: 5 },
					instruments: {
						"coincheck:xrp_jpy": {
							scores: { sentiment: -40, risk: 30 },
							duration: "medium",
						},
						"coincheck:eth_jpy": {
							scores: { sentiment: 60, risk: 0 },
							duration: "long",
						},
					},
				}),
			),
			scored(2, "記事 B"),
		];
		const view = renderApp("/news", newsApi({ news: () => news }));
		const [a, b] = (await view.findAllByTestId("news-card")) as HTMLElement[];
		const rows = within(a as HTMLElement)
			.getAllByTestId("score-row")
			.map((r) => r.textContent);
		expect(rows).toEqual([
			"全体センチ 10リスク 5持続 短期",
			"ETHセンチ 60リスク 0持続 長期",
			"XRPセンチ -40リスク 30持続 中期",
		]);
		// 個別の点数が無い記事は今どおり銘柄名を付けない
		const only = within(b as HTMLElement).getAllByTestId("score-row");
		expect(only).toHaveLength(1);
		expect(only[0]?.textContent).not.toContain("全体");
	});

	test("値動きを測るまでは記事に精度の測定中を出し、市場評価には精度を出さない", async () => {
		const news = [scored(1, "記事 A")];
		const view = renderApp("/news", newsApi({ news: () => news }));
		expect((await view.findByTestId("article-precision")).textContent).toBe(
			"精度（24h） 測定中",
		);
		expect(view.getByTestId("judge-sentiment").textContent).not.toContain(
			"精度",
		);
	});

	test("採点が止まると知らせ、失敗した記事は再試行を頼める", async () => {
		const failed = newsItem({
			id: 1,
			title: "失敗した記事",
			publishedAt: Date.now() - HOUR,
			score: newsScore({
				status: "failed",
				scores: null,
				duration: null,
				error: "HTTP 503",
			}),
		});
		let news = [failed];
		let scorer = scorerStatus({
			state: "stopped",
			error: "採点に3回続けて失敗した",
			stoppedSince: Date.now(),
		});
		const api = newsApi({ news: () => news })
			.on(routes.api.scoring.status, "$get", () => scorer)
			.on(routes.api.scoring.news[":id"].retry, "$post", () => {
				news = [
					scored(1, "失敗した記事", newsScore({ comment: "直った採点。" })),
				];
				scorer = scorerStatus();
				return { ok: true as const };
			});
		const view = renderApp("/news", api);
		const alert = await view.findByText("ニュースの採点が止まっている");
		expect(alert.closest("[role=alert]")?.textContent).toContain(
			"採点に3回続けて失敗した",
		);
		const card = within(cards(view)[0] as HTMLElement);
		expect(card.getByText(/HTTP 503/)).toBeTruthy();
		fireEvent.click(card.getByRole("button", { name: "再試行" }));
		expect(await view.findByText("直った採点。")).toBeTruthy();
		expect(
			api.requests.some((r) => r.path === "/api/scoring/news/1/retry"),
		).toBe(true);
		await waitFor(() =>
			expect(view.queryByText("ニュースの採点が止まっている")).toBeNull(),
		);
	});

	test("使用中と違う版の記事は「詳しく」を開いたときだけ採点し直せ、頼んだ記事だけ採点し直す", async () => {
		const scorer = scorerStatus({ activeCriteriaVersion: 2 });
		let news = [scored(1, "記事 A"), scored(2, "記事 B")];
		const api = newsApi({ news: () => news, scorer }).on(
			routes.api.scoring.news[":id"].rescore,
			"$post",
			(req) => {
				const id = Number(req.params.id);
				news = news.map((n) =>
					n.id === id && n.score
						? {
								...n,
								score: {
									...n.score,
									criteriaVersion: 2,
									rescoredAt: Date.now(),
								},
							}
						: n,
				);
				return { version: 2 };
			},
		);
		const view = renderApp("/news", api);
		await view.findAllByTestId("news-card");
		expect(view.queryByRole("button", { name: "v2 で採点し直す" })).toBeNull();
		const [a, b] = cards(view) as HTMLElement[];
		fireEvent.click(
			within(a as HTMLElement).getByRole("button", { name: /詳しく/ }),
		);
		fireEvent.click(
			within(a as HTMLElement).getByRole("button", { name: "v2 で採点し直す" }),
		);
		await waitFor(() => expect(a?.textContent).toContain("プロンプト v2"));
		expect(a?.textContent).toContain("採点し直し");
		expect(
			within(a as HTMLElement).queryByRole("button", {
				name: "v2 で採点し直す",
			}),
		).toBeNull();
		fireEvent.click(
			within(b as HTMLElement).getByRole("button", { name: /詳しく/ }),
		);
		expect(b?.textContent).toContain("プロンプト v1");
	});
});

describe("絞り込み", () => {
	test("キーワード・影響の大きさ・日付で絞り込み、URL に持つ。日付で絞るとその時点の市場評価を出す", async () => {
		const all = [scored(1, "半減期の記事"), scored(2, "別の話題")];
		const api = newsApi({ news: () => all }).on(
			routes.api.news,
			"$get",
			(req) => {
				const q = req.query.get("q") ?? "";
				const news = all.filter((n) => n.title.includes(q));
				return { news, total: news.length };
			},
		);
		const view = renderApp("/news", api);
		await view.findAllByTestId("news-card");
		changeValue(view.getByLabelText("キーワード"), "半減期");
		// 打ち終えてから問い合わせる
		await waitFor(() => expect(cards(view)).toHaveLength(1), {
			timeout: 2000,
		});
		expect(view.location.current).toBe(
			`/news?q=${encodeURIComponent("半減期")}`,
		);
		expect(view.getByText(/条件に当てはまる 1 件/)).toBeTruthy();

		const bull = view.getByRole("button", { name: "強気材料" });
		fireEvent.click(bull);
		expect(view.location.current).toContain("impact=bull");
		expect(
			view
				.getByRole("button", { name: "強気材料" })
				.getAttribute("aria-pressed"),
		).toBe("true");

		fireEvent.click(view.getByRole("button", { name: /絞り込み/ }));
		const dialog = within(view.getByRole("dialog", { name: "絞り込み" }));
		fireEvent.click(dialog.getByRole("radio", { name: "日付を指定" }));
		const yesterday = new Date(Date.now() + 9 * HOUR - 24 * HOUR)
			.toISOString()
			.slice(0, 10);
		changeValue(dialog.getByLabelText("終了日"), yesterday);
		fireEvent.click(dialog.getByRole("button", { name: "この条件で見る" }));
		expect(view.location.current).toContain(`period=custom&to=${yesterday}`);
		expect(
			await view.findByRole("heading", { name: "過去の時点の市場評価" }),
		).toBeTruthy();

		fireEvent.click(view.getByRole("button", { name: /絞り込み/ }));
		const again = within(view.getByRole("dialog", { name: "絞り込み" }));
		fireEvent.click(again.getByRole("button", { name: "条件をクリア" }));
		fireEvent.click(again.getByRole("button", { name: "この条件で見る" }));
		expect(
			await view.findByRole("heading", { name: "今の市場評価" }),
		).toBeTruthy();
		expect(view.location.current).toBe(
			`/news?q=${encodeURIComponent("半減期")}`,
		);
	});
});

describe("評価詳細", () => {
	test("市場評価に使った記事の段階ごとの件数・平均点・重みの割合と、精度の集計を出す", async () => {
		const news = [
			scored(1, "記事 A", newsScore({ scores: { sentiment: 70, risk: 10 } })),
			scored(2, "記事 B", newsScore({ scores: { sentiment: 0, risk: 45 } })),
		];
		const view = renderApp("/news", newsApi({ news: () => news }));
		await view.findAllByTestId("news-card");
		fireEvent.click(view.getByRole("tab", { name: "評価詳細" }));
		expect(view.location.current).toBe("/news?tab=evaluation");
		expect(view.getByRole("heading", { name: "市場評価の内訳" })).toBeTruthy();
		const rows = within(view.getByTestId("breakdown-sentiment"))
			.getAllByRole("row")
			.map((r) => r.textContent);
		// 同じ時刻の記事なので重みは等しい
		expect(rows).toEqual([
			"記事の点数の段階件数平均点重みの割合",
			"かなり強気1件70点50%",
			"やや強気0件—0%",
			"中立1件0点50%",
			"やや弱気0件—0%",
			"かなり弱気0件—0%",
		]);
		expect(
			within(view.getByTestId("breakdown-risk")).getAllByRole("row"),
		).toHaveLength(6);

		expect(
			(await view.findByTestId("accuracy-summary-setting")).textContent,
		).toBe("直近30日・24h");
		const precision = view.getByTestId("accuracy-summary-sentiment");
		expect(precision.textContent).toContain("精度を出せた記事なし");
		expect(
			within(precision)
				.getAllByRole("button")
				.map((b) => b.textContent),
		).toEqual(["0件", "0件", "0件", "0件", "0件"]);
		expect(
			within(view.getByTestId("accuracy-summary-risk")).getAllByRole("button"),
		).toHaveLength(5);
		expect(
			view.getAllByRole("list", { name: "リスクの色の意味" }),
		).toHaveLength(1);

		fireEvent.click(view.getByRole("tab", { name: "記事" }));
		expect(view.location.current).toBe("/news");
	});

	test("分析は見せ方を切り替えられ、棒を押すと内訳を出す。見せ方はブラウザに保存する", async () => {
		const summary = accuracySummary({
			results: {
				sentiment: accuracyResult(
					"sentiment",
					[[0, 1, 2], [], [0, 0, 1], [], [2]],
					{
						"+2": [2, 0, 0, 0, 0],
						"+1": [0, 0, 0, 1, 0],
						"0": [0, 0, 2, 0, 1],
					},
				),
				risk: accuracyResult("risk"),
			},
		});
		const api = newsApi({ news: () => [], summary });
		const view = renderApp("/news?tab=evaluation", api);
		const card = within(await view.findByTestId("accuracy-summary-sentiment"));
		expect(
			view.getByTestId("accuracy-summary-sentiment").textContent,
		).toContain("6件");
		expect(
			(card.getByRole("button", { name: "精度 高: 0件" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		const best = card.getByRole("button", { name: "精度 最高: 3件" });
		fireEvent.click(best);
		expect(card.getByTestId("accuracy-summary-detail").textContent).toBe(
			"精度 最高: やや強気 1件（33%） · 中立 2件（67%）",
		);
		fireEvent.click(best);
		expect(card.queryByTestId("accuracy-summary-detail")).toBeNull();

		// 評価ごと: 横軸が記事の段階で、棒の中は精度
		const view_ = within(view.getByRole("group", { name: "見せ方" }));
		fireEvent.click(view_.getByRole("radio", { name: "評価ごと" }));
		expect(card.getAllByRole("button").map((b) => b.textContent)).toEqual([
			"0件",
			"0件",
			"3件",
			"1件",
			"2件",
		]);
		fireEvent.click(card.getByRole("button", { name: "中立: 3件" }));
		expect(card.getByTestId("accuracy-summary-detail").textContent).toBe(
			"中立: 精度 最高 2件（67%） · 精度 中 1件（33%）",
		);
		expect(view.getAllByRole("list", { name: "精度の色の意味" })).toHaveLength(
			2,
		);

		// 評価×値動き: 行が記事の段階、列が値動き。割合は行ごと
		fireEvent.click(view_.getByRole("radio", { name: "評価×値動き" }));
		const cells = (name: RegExp) =>
			within(card.getByRole("row", { name }))
				.getAllByRole("cell")
				.map((c) => c.textContent);
		expect(cells(/^中立/)).toEqual(["0件", "0件", "2件", "0件", "1件"]);
		fireEvent.click(
			within(view.getByRole("group", { name: "件数か割合か" })).getByRole(
				"radio",
				{ name: "割合" },
			),
		);
		expect(cells(/^中立/)).toEqual(["0%", "0%", "67%", "0%", "33%"]);
		expect(cells(/^やや弱気/)).toEqual(["—", "—", "—", "—", "—"]);

		cleanup();
		const again = renderApp("/news?tab=evaluation", api);
		const reopened = within(
			await again.findByTestId("accuracy-summary-sentiment"),
		);
		expect(
			within(reopened.getByRole("row", { name: /^中立/ }))
				.getAllByRole("cell")
				.map((c) => c.textContent),
		).toEqual(["0%", "0%", "67%", "0%", "33%"]);
	});

	test("分析はプロンプト・サーバーの版とモデルで絞り込み、URL に持つ", async () => {
		const built = Date.parse("2026-10-07T12:05:00Z");
		const api = newsApi({ news: () => [] }).on(
			routes.api.scoring.accuracy.summary,
			"$get",
			(req) => {
				const cv = req.query.get("criteriaVersion");
				const app = req.query.get("appBuiltAt");
				const model = req.query.get("model");
				return accuracySummary({
					filter: {
						criteriaVersion: cv ? Number(cv) : null,
						appBuiltAt: app === "none" ? "none" : app ? Number(app) : null,
						model: model || null,
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
						models: [
							{ model: "openai:claude-sonnet", count: 20 },
							{ model: "gemini-3.5-flash-lite", count: 18 },
							{ model: null, count: 14 },
						],
						activeCriteriaVersion: 3,
						activeModel: "openai:claude-sonnet",
					},
				});
			},
		);
		const view = renderApp("/news?tab=evaluation", api);
		const options = (el: HTMLElement) =>
			within(el)
				.getAllByRole("option")
				.map((o) => o.textContent);
		const prompt = () =>
			view.getByRole("combobox", { name: "プロンプト" }) as HTMLSelectElement;
		const server = () =>
			view.getByRole("combobox", { name: "サーバー" }) as HTMLSelectElement;
		const model = () =>
			view.getByRole("combobox", { name: "モデル" }) as HTMLSelectElement;
		await waitFor(() =>
			expect(options(prompt())).toEqual([
				"すべて",
				"v3（12件）使用中",
				"v2（40件）",
			]),
		);
		expect(options(server())).toEqual([
			"すべて",
			"Ver 10-07 21:05（30件）",
			"Ver 記録なし（22件）",
		]);
		// Gemini 直結を先、OpenAI 互換は印を外した名前で後、記録なしは最後
		expect(options(model())).toEqual([
			"すべて",
			"gemini-3.5-flash-lite（18件）",
			"claude-sonnet（20件）使用中",
			"記録なし（14件）",
		]);
		fireEvent.change(prompt(), { target: { value: "2" } });
		fireEvent.change(server(), { target: { value: String(built) } });
		fireEvent.change(model(), { target: { value: "openai:claude-sonnet" } });
		expect(view.location.current).toContain("prompt=2");
		expect(view.location.current).toContain(`server=${built}`);
		expect(view.location.current).toContain("model=openai%3Aclaude-sonnet");
		await waitFor(() =>
			expect(view.getByTestId("accuracy-summary-setting").textContent).toBe(
				"直近30日・24h・v2・Ver 10-07 21:05・claude-sonnet",
			),
		);

		// 一覧の絞り込みを変えても残る
		fireEvent.click(view.getByRole("tab", { name: "記事" }));
		fireEvent.click(await view.findByRole("button", { name: "強気材料" }));
		expect(view.location.current).toContain("impact=");
		fireEvent.click(view.getByRole("tab", { name: "評価詳細" }));
		await waitFor(() => expect(prompt().value).toBe("2"));
		expect(model().value).toBe("openai:claude-sonnet");
		fireEvent.change(model(), { target: { value: "" } });
		fireEvent.change(prompt(), { target: { value: "" } });
		expect(view.location.current).not.toContain("prompt=");
		await waitFor(() =>
			expect(view.getByTestId("accuracy-summary-setting").textContent).toBe(
				"直近30日・24h・Ver 10-07 21:05",
			),
		);

		// URL に持つので、開き直しても残る
		const url = view.location.current;
		cleanup();
		const again = renderApp(url, api);
		await waitFor(() =>
			expect(
				(again.getByRole("combobox", { name: "サーバー" }) as HTMLSelectElement)
					.value,
			).toBe(String(built)),
		);
	});
});
