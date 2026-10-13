import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type {
	AccuracySettings,
	CompatibleConnectionStatus,
	CriteriaVersion,
	NewsSource,
} from "@trading-studio/backend";
import type { AggregationRule } from "@trading-studio/core";
import { DEFAULT_AGGREGATION_RULE } from "@trading-studio/core";
import { changeValue, setupDom } from "../src/shared/lib/test-setup";
import type { FakeApi } from "./fake-api";
import { createFakeApi, routes } from "./fake-api";
import {
	currentJudgment,
	newsCollectorStatus,
	newsItem,
	newsScore,
	newsSource,
	scorerStatus,
} from "./fixtures";
import { renderApp } from "./render-app";

setupDom();

afterEach(async () => {
	await new Promise((r) => setTimeout(r, 20));
	cleanup();
});

const GEMINI_MODELS = [
	{ id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite" },
	{ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
	{ id: "gemini-3.8-pro", label: "Gemini 3.8 Pro" },
];

/** ニュースの設定が読む口（評価ルールと取得の状態） */
function settingsApi(sources: () => NewsSource[] = () => []): FakeApi {
	return createFakeApi()
		.on(routes.api.judgments.current, "$get", () =>
			currentJudgment([], Date.now()),
		)
		.on(routes.api.news.status, "$get", () =>
			newsCollectorStatus({ sources: sources() }),
		);
}

/** 採点に使うモデルの口。保存したモデルを返す */
function withModel(api: FakeApi, initial = "gemini-3.5-flash-lite"): FakeApi {
	let current = initial;
	return api
		.on(routes.api.scoring.model, "$get", () => ({
			models: GEMINI_MODELS,
			current,
		}))
		.on(routes.api.scoring.model, "$put", (req) => {
			current = (req.body as { model: string }).model;
			return { models: GEMINI_MODELS, current };
		});
}

const bodiesOf = (api: FakeApi, method: string, path: string) =>
	api.requests
		.filter((r) => r.method === method && r.path === path)
		.map((r) => r.body);

describe("評価ルール", () => {
	test("ニュース画面の「設定」から開き、境目を入れると上限と今の評価の試算が変わり、保存できる。順序が崩れると保存できない", async () => {
		const t = Date.now() - 3_600_000;
		const news = [
			newsItem({
				id: 1,
				title: "記事",
				publishedAt: t,
				score: newsScore({ scores: { sentiment: -30, risk: 0 }, scoredAt: t }),
			}),
		];
		const api = settingsApi()
			.on(routes.api.news, "$get", () => ({ news, total: 1 }))
			.on(routes.api.scoring.status, "$get", () => scorerStatus())
			.on(routes.api.scoring.accuracy, "$get", () => ({
				horizon: "24h" as const,
				items: [],
			}))
			.on(routes.api.judgments.preview, "$post", (req) => {
				const { rule } = req.body as { rule: AggregationRule };
				return currentJudgment(news, Date.now(), rule);
			})
			.on(
				routes.api.judgments.rule,
				"$put",
				(req) => req.body as { rule: AggregationRule },
			);
		const view = renderApp("/news", api);
		const main = within(await view.findByRole("main"));
		fireEvent.click(main.getByRole("link", { name: "設定" }));
		expect(view.location.current).toBe("/settings?section=news");

		// -30 点はやや弱気。やや強気の下限を -40 点にすればやや強気になる。負の数も入れられる
		changeValue(await view.findByLabelText("中立"), "-41");
		changeValue(view.getByLabelText("やや強気"), "-40");
		// 上限は上の範囲の下限から決まる
		expect(view.getByText("〜 -41 点")).toBeTruthy();
		await waitFor(() =>
			expect(view.getByTestId("rule-preview").textContent).toContain(
				"やや強気",
			),
		);
		fireEvent.click(view.getByRole("button", { name: "保存" }));
		expect((await view.findByRole("status")).textContent).toContain(
			"評価ルールを保存した",
		);
		expect(bodiesOf(api, "PUT", "/api/judgments/rule")).toEqual([
			{
				rule: {
					...DEFAULT_AGGREGATION_RULE,
					thresholds: {
						...DEFAULT_AGGREGATION_RULE.thresholds,
						sentiment: {
							...DEFAULT_AGGREGATION_RULE.thresholds.sentiment,
							plus1: -40,
							minus1: -41,
						},
					},
				},
			},
		]);

		changeValue(view.getByLabelText("やや強気"), "-42");
		expect(view.getByText("やや強気の下限（-42）以下にする")).toBeTruthy();
		expect(
			(view.getByRole("button", { name: "保存" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});
});

describe("精度", () => {
	test("測る長さ・境目・期間を変えて保存する。境目の順序が崩れると保存できない", async () => {
		const saved: AccuracySettings = {
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
		};
		const api = settingsApi()
			.on(routes.api.scoring.accuracy.settings, "$get", () => saved)
			.on(
				routes.api.scoring.accuracy.settings,
				"$put",
				(req) => req.body as AccuracySettings,
			);
		const view = renderApp("/settings?section=news&tab=accuracy", api);
		const period = within(
			await view.findByRole("group", { name: "集計する期間" }),
		);
		fireEvent.click(period.getByRole("radio", { name: "7日" }));
		fireEvent.click(
			within(view.getByRole("group", { name: "値動きを測る長さ" })).getByRole(
				"radio",
				{ name: "4時間後" },
			),
		);
		const rough = view.getByLabelText(
			"リスクの境目 24時間後 荒れた（以上）",
		) as HTMLInputElement;
		expect(rough.value).toBe("2");
		changeValue(rough, "4");
		expect(
			view.getByText(/やや荒れ < 荒れた < かなり荒れ < 大荒れ/),
		).toBeTruthy();
		const save = () =>
			view.getByRole("button", { name: "保存" }) as HTMLButtonElement;
		expect(save().disabled).toBe(true);
		changeValue(rough, "2.5");
		fireEvent.click(save());
		expect((await view.findByRole("status")).textContent).toContain("保存した");
		expect(bodiesOf(api, "PUT", "/api/scoring/accuracy/settings")).toEqual([
			{
				...saved,
				horizon: "4h",
				periodDays: 7,
				riskBands: {
					...saved.riskBands,
					"24h": { ...saved.riskBands["24h"], rough: 2.5 },
				},
			},
		]);
	});
});

describe("プロンプト", () => {
	test("基準を試し採点し、版として保存して使用中にする", async () => {
		const versions: CriteriaVersion[] = [
			{ version: 1, text: "- 初版の基準", note: "初版", createdAt: 0 },
		];
		let active = 1;
		const t = Date.now() - 3_600_000;
		const news = [1, 2, 3].map((id) =>
			newsItem({
				id,
				title: `記事 ${id}`,
				publishedAt: t,
				score: newsScore({ comment: `保存済みの理由 ${id}`, scoredAt: t }),
			}),
		);
		const api = withModel(settingsApi())
			.on(routes.api.scoring.criteria, "$get", () => ({
				versions,
				activeVersion: active,
				template: "記事: {news}\n基準: {criteria}",
			}))
			.on(routes.api.scoring.criteria, "$post", (req) => {
				const { text, note } = req.body as { text: string; note: string };
				const v = { version: versions.length + 1, text, note, createdAt: 0 };
				versions.push(v);
				return { version: v };
			})
			.on(routes.api.scoring.criteria.active, "$put", (req) => {
				active = (req.body as { version: number }).version;
				return {
					versions,
					activeVersion: active,
					template: "記事: {news}\n基準: {criteria}",
				};
			})
			.on(routes.api.news, "$get", () => ({ news, total: news.length }))
			.on(routes.api.scoring.trial, "$post", (req) => {
				const { newsIds } = req.body as { newsIds?: number[] };
				const picked = news.filter((n) => (newsIds ?? [1]).includes(n.id));
				return {
					ok: true as const,
					items: picked.map((n) => ({
						news: {
							id: n.id,
							title: n.title,
							sourceName: n.sourceName,
							publishedAt: n.publishedAt,
							stored: {
								scores: { sentiment: 30, risk: 10 },
								duration: "short" as const,
								comment: n.score?.comment ?? null,
								criteriaVersion: 1,
							},
						},
						result: {
							ok: true as const,
							scores: { sentiment: -10, risk: 20 },
							duration: "medium" as const,
							comment: `試した理由 ${n.id}`,
						},
					})),
				};
			});
		const view = renderApp("/settings?section=news&tab=prompt", api);
		const text = (await view.findByLabelText(/採点の基準/, {
			selector: "textarea",
		})) as HTMLTextAreaElement;
		expect(text.value).toBe("- 初版の基準");
		changeValue(text, "- 新しい基準");

		fireEvent.click(view.getByRole("button", { name: "最新のニュースで試す" }));
		expect((await view.findByTestId("trial-result")).textContent).toContain(
			"試した理由 1",
		);

		fireEvent.click(view.getByRole("button", { name: "試す記事を選ぶ" }));
		const dialog = within(
			await view.findByRole("dialog", { name: "試す記事を選ぶ" }),
		);
		const boxes = await dialog.findAllByRole("checkbox");
		fireEvent.click(boxes[1] as HTMLElement);
		fireEvent.click(boxes[2] as HTMLElement);
		fireEvent.click(dialog.getByRole("button", { name: "2 件で決定" }));
		expect(view.getByTestId("trial-targets").textContent).toContain(
			"選んだ 2 件",
		);
		fireEvent.click(view.getByRole("button", { name: "選んだ記事で試す" }));
		await waitFor(() =>
			expect(view.getAllByTestId("trial-result")).toHaveLength(2),
		);
		const first = view.getAllByTestId("trial-result")[0]?.textContent;
		expect(first).toContain("試した理由 2");
		expect(first).toContain("保存済みの採点（v1）");
		expect(first).toContain("保存済みの理由 2");
		expect(bodiesOf(api, "POST", "/api/scoring/trial").at(-1)).toEqual({
			criteria: "- 新しい基準",
			newsIds: [2, 3],
		});

		fireEvent.click(view.getByRole("button", { name: "v2 として保存" }));
		expect((await view.findByText(/v2 を保存した/)).textContent).toContain(
			"使用中は v1 のまま",
		);
		fireEvent.click(
			within(await view.findByTestId("criteria-v2")).getByRole("button", {
				name: "使用する",
			}),
		);
		await waitFor(() =>
			expect(view.getByTestId("criteria-v2").textContent).toContain("使用中"),
		);
		expect(bodiesOf(api, "PUT", "/api/scoring/criteria/active")).toEqual([
			{ version: 2 },
		]);
	});

	test("採点に使うモデルを選んで保存する", async () => {
		const api = withModel(settingsApi())
			.on(routes.api.scoring.criteria, "$get", () => ({
				versions: [{ version: 1, text: "- 基準", note: "", createdAt: 0 }],
				activeVersion: 1,
				template: "{news}{criteria}",
			}))
			.on(routes.api.ai.compatible.models, "$get", () => ({
				ok: false as const,
				message: "接続先が設定されていない",
			}));
		const view = renderApp("/settings?section=news&tab=prompt", api);
		const model = (await view.findByLabelText("採点に使うモデル", {
			selector: "input",
		})) as HTMLInputElement;
		await waitFor(() => expect(model.value).toBe("Gemini 3.5 Flash Lite"));
		fireEvent.click(model);
		fireEvent.click(
			await view.findByRole("option", { name: "Gemini 3.8 Flash" }),
		);
		fireEvent.click(
			view.getAllByRole("button", { name: "保存" })[0] as HTMLElement,
		);
		expect(
			(await view.findByText(/モデルを保存した/)).textContent,
		).toBeTruthy();
		expect(bodiesOf(api, "PUT", "/api/scoring/model")).toEqual([
			{ model: "gemini-3.8-flash" },
		]);
		expect(model.value).toBe("Gemini 3.8 Flash");
	});
});

describe("取得", () => {
	test("取得元の追加・無効化・削除と、取得間隔の保存", async () => {
		let sources = [newsSource({ id: 1, name: "既存" })];
		let interval = 15;
		const api = settingsApi(() => sources)
			.on(routes.api.news.status, "$get", () =>
				newsCollectorStatus({ sources, intervalMinutes: interval }),
			)
			.on(routes.api.news.sources, "$post", (req) => {
				const { name, url } = req.body as { name: string; url: string };
				const s = newsSource({ id: 2, name, url, lastSuccessAt: Date.now() });
				sources = [...sources, s];
				return { source: s };
			})
			.on(routes.api.news.sources[":id"], "$patch", (req) => {
				const { enabled } = req.body as { enabled: boolean };
				sources = sources.map((s) =>
					String(s.id) === req.params.id ? { ...s, enabled } : s,
				);
				const source = sources.find((s) => String(s.id) === req.params.id);
				return { source: source as NewsSource };
			})
			.on(routes.api.news.sources[":id"], "$delete", (req) => {
				sources = sources.filter((s) => String(s.id) !== req.params.id);
				return { ok: true as const };
			})
			.on(routes.api.news.settings, "$put", (req) => {
				interval = (req.body as { intervalMinutes: number }).intervalMinutes;
				return { intervalMinutes: interval };
			});
		const view = renderApp("/settings?section=news&tab=sources", api);
		changeValue(await view.findByLabelText("名前"), "追加した取得元");
		changeValue(view.getByLabelText("RSS の URL"), "https://news.example/rss");
		fireEvent.click(view.getByRole("button", { name: "追加する" }));
		const row = await waitFor(() => {
			const r = view
				.getAllByTestId("news-source")
				.find((x) => x.textContent?.includes("追加した取得元"));
			if (!r) throw new Error("追加した取得元が出ていない");
			return r;
		});
		expect(row.textContent).toContain("最後に取得");
		expect(bodiesOf(api, "POST", "/api/news/sources")).toEqual([
			{
				name: "追加した取得元",
				url: "https://news.example/rss",
				language: "ja",
			},
		]);

		fireEvent.click(
			view.getByRole("switch", { name: "追加した取得元 から取得する" }),
		);
		await waitFor(() =>
			expect(
				view
					.getByRole("switch", { name: "追加した取得元 から取得する" })
					.getAttribute("aria-checked"),
			).toBe("false"),
		);

		changeValue(view.getByLabelText("取得間隔（分）"), "30");
		fireEvent.click(
			within(
				view.getByLabelText("取得間隔（分）").closest("div") as HTMLElement,
			).getByRole("button", { name: "保存" }),
		);
		expect(await view.findByText(/取得間隔を保存した/)).toBeTruthy();
		expect(bodiesOf(api, "PUT", "/api/news/settings")).toEqual([
			{ intervalMinutes: 30 },
		]);

		fireEvent.click(
			view.getByRole("button", { name: "追加した取得元 を削除" }),
		);
		fireEvent.click(
			within(view.getByRole("dialog")).getByRole("button", {
				name: "削除する",
			}),
		);
		await waitFor(() =>
			expect(view.getAllByTestId("news-source")).toHaveLength(1),
		);
		expect(api.requests.some((r) => r.method === "DELETE")).toBe(true);
	});
});

describe("AI の接続", () => {
	test("Gemini の API キーは保存・上書き・削除でき、入れたキーは画面に残さない", async () => {
		let configured = false;
		const api = createFakeApi()
			.on(routes.api.scoring["api-key"], "$get", () => ({
				configured,
				savedAt: configured ? Date.now() : null,
			}))
			.on(routes.api.scoring["api-key"], "$put", () => {
				configured = true;
				return { configured, savedAt: Date.now() };
			})
			.on(routes.api.scoring["api-key"], "$delete", () => {
				configured = false;
				return { configured, savedAt: null };
			});
		const view = renderApp("/settings", api);
		const state = view.getByTestId("api-key-state");
		await waitFor(() => expect(state.textContent).toBe("未設定"));
		const input = view.getByLabelText("Gemini の API キー", {
			selector: "input",
		}) as HTMLInputElement;
		expect(input.type).toBe("password");
		const submit = () =>
			within(input.parentElement as HTMLElement).getByRole("button");
		changeValue(input, "secret-1");
		expect(submit().textContent).toBe("保存");
		fireEvent.click(submit());
		expect(await view.findByText("API キーを保存した")).toBeTruthy();
		await waitFor(() => expect(state.textContent).toContain("設定済み"));
		expect(input.value).toBe("");
		expect(document.body.textContent).not.toContain("secret-1");

		changeValue(input, "secret-2");
		expect(submit().textContent).toBe("上書き");
		fireEvent.click(submit());
		await waitFor(() => expect(input.value).toBe(""));
		expect(bodiesOf(api, "PUT", "/api/scoring/api-key")).toEqual([
			{ key: "secret-1" },
			{ key: "secret-2" },
		]);

		fireEvent.click(view.getByRole("button", { name: "キーを削除" }));
		fireEvent.click(
			within(view.getByRole("dialog")).getByRole("button", {
				name: "削除する",
			}),
		);
		await waitFor(() => expect(state.textContent).toBe("未設定"));
		expect(view.queryByRole("button", { name: "キーを削除" })).toBeNull();
	});

	test("OpenAI 互換の接続先を保存して確かめると、採点のモデルに接続先のモデルが並び、入力で絞り込んで選べる", async () => {
		let compatible: CompatibleConnectionStatus = {
			baseUrl: null,
			keyConfigured: false,
			keySavedAt: null,
		};
		const models = [
			"openai/gpt-demo",
			"openai/gpt-demo-mini",
			"anthropic/claude-demo",
			"google/gemini-demo",
		].map((m) => ({ id: `openai:${m}`, label: m }));
		const api = withModel(settingsApi())
			.on(routes.api.ai.compatible, "$get", () => compatible)
			.on(routes.api.ai.compatible, "$put", (req) => {
				const { baseUrl, apiKey } = req.body as {
					baseUrl: string;
					apiKey?: string;
				};
				compatible = {
					baseUrl,
					keyConfigured: apiKey !== undefined,
					keySavedAt: apiKey === undefined ? null : Date.now(),
				};
				return compatible;
			})
			.on(routes.api.ai.compatible, "$delete", () => {
				compatible = { baseUrl: null, keyConfigured: false, keySavedAt: null };
				return compatible;
			})
			.on(routes.api.ai.compatible.models, "$get", () =>
				compatible.baseUrl === null
					? { ok: false as const, message: "接続先が設定されていない" }
					: { ok: true as const, models },
			)
			.on(routes.api.scoring.criteria, "$get", () => ({
				versions: [{ version: 1, text: "- 基準", note: "", createdAt: 0 }],
				activeVersion: 1,
				template: "{news}{criteria}",
			}))
			.on(routes.api.scoring["api-key"], "$get", () => ({
				configured: true,
				savedAt: 0,
			}));

		const prompt = renderApp("/settings?section=news&tab=prompt", api);
		const picker = () =>
			prompt.getByLabelText("採点に使うモデル", {
				selector: "input",
			}) as HTMLInputElement;
		await waitFor(() => expect(picker().disabled).toBe(false));
		fireEvent.click(picker());
		expect(
			(await prompt.findByTestId("compatible-models-note")).textContent,
		).toContain("接続先が設定されていない");
		cleanup();

		const general = renderApp("/settings", api);
		const state = general.getByTestId("compatible-state");
		await waitFor(() => expect(state.textContent).toBe("未設定"));
		changeValue(
			general.getByLabelText("URL", { exact: true }),
			"http://bifrost:8080/v1",
		);
		changeValue(
			general.getByLabelText("API キー", { exact: true }),
			"virtual-key",
		);
		const card = within(state.parentElement as HTMLElement);
		fireEvent.click(card.getByRole("button", { name: "保存" }));
		expect(await general.findByText("接続先を保存した")).toBeTruthy();
		await waitFor(() =>
			expect(state.textContent).toContain("設定済み（キー保存"),
		);
		expect(document.body.textContent).not.toContain("virtual-key");
		expect(bodiesOf(api, "PUT", "/api/ai/compatible")).toEqual([
			{ baseUrl: "http://bifrost:8080/v1", apiKey: "virtual-key" },
		]);
		fireEvent.click(card.getByRole("button", { name: "接続を確かめる" }));
		expect(await general.findByText("つながった（モデル 4 件）")).toBeTruthy();
		cleanup();

		const again = renderApp("/settings?section=news&tab=prompt", api);
		const picker2 = () =>
			again.getByLabelText("採点に使うモデル", {
				selector: "input",
			}) as HTMLInputElement;
		await waitFor(() => expect(picker2().disabled).toBe(false));
		fireEvent.click(picker2());
		await waitFor(() => expect(again.getAllByRole("option")).toHaveLength(7));
		changeValue(picker2(), "gpt mini");
		await waitFor(() => expect(again.getAllByRole("option")).toHaveLength(1));
		fireEvent.keyDown(picker2(), { key: "Enter" });
		expect(picker2().value).toBe("openai/gpt-demo-mini（OpenAI 互換）");
		fireEvent.click(
			again.getAllByRole("button", { name: "保存" })[0] as HTMLElement,
		);
		expect(await again.findByText(/モデルを保存した/)).toBeTruthy();
		expect(bodiesOf(api, "PUT", "/api/scoring/model")).toEqual([
			{ model: "openai:openai/gpt-demo-mini" },
		]);
		cleanup();

		const last = renderApp("/settings", api);
		const lastState = last.getByTestId("compatible-state");
		await waitFor(() => expect(lastState.textContent).toContain("設定済み"));
		fireEvent.click(last.getByRole("button", { name: "接続先を削除" }));
		fireEvent.click(
			within(last.getByRole("dialog")).getByRole("button", {
				name: "削除する",
			}),
		);
		await waitFor(() => expect(lastState.textContent).toBe("未設定"));
	});
});
