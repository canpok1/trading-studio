// 入力欄を1つずつ空欄にしても画面が落ちないこと。
// 画面は検証前の入力途中の値（空欄は NaN）でも計算し、バックテストの下書きはブラウザに残るので、
// 落ちると開き直しても同じく落ち続ける
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup } from "@testing-library/react";
import type {
	Condition,
	ConditionGroup,
	ConditionSet,
} from "@trading-studio/core";
import { DEFAULT_AGGREGATION_RULE } from "@trading-studio/core";
import { changeValue, setupDom } from "../src/shared/lib/test-setup";
import { createFakeApi, routes } from "./fake-api";
import { coverage, storedStrategy } from "./fixtures";
import { renderApp } from "./render-app";

setupDom();

// バックテストの実行画面は描くのが重く、既定の 1 秒では読み込みが終わらないことがある
const WAIT = { timeout: 5000 };

afterEach(async () => {
	await new Promise((r) => setTimeout(r, 20));
	cleanup();
});
beforeEach(() => localStorage.clear());

const H = 3_600_000;
// JST 2026-05-01 00:00 から10日分の1時間足がある
const START = Date.UTC(2026, 3, 30, 15);
const END = START + 239 * H;

const all = (conditions: Condition[]): ConditionGroup => ({
	match: "all",
	conditions,
});
const any = (conditions: Condition[]): ConditionGroup => ({
	match: "any",
	conditions,
});

// 条件の種類と注文の出し方をひととおり持つ戦略
const PARAMS: ConditionSet = {
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

/** 戦略1つと、10日分の1時間足がある状態の偽物 */
function robustApi() {
	return createFakeApi()
		.on(routes.api.strategies, "$get", () => ({
			strategies: [
				storedStrategy({
					id: 1,
					name: "空欄",
					params: PARAMS,
					createdAt: START,
					updatedAt: START,
				}),
			],
		}))
		.on(routes.api.data.coverage, "$get", () => ({
			timeframes: [
				coverage({
					timeframe: "1h",
					count: 240,
					firstTime: START,
					lastTime: END,
				}),
			],
		}))
		.on(routes.api.data.latest, "$get", () => ({
			latest: { time: END, close: 10_000_000 },
		}))
		.on(routes.api.judgments.current, "$get", () => ({
			time: END,
			rule: DEFAULT_AGGREGATION_RULE,
			results: {
				sentiment: { value: "0" as const, average: null, count: 0 },
				risk: { value: "calm" as const, average: null, count: 0 },
			},
			weights: {},
			breakdown: { sentiment: [], risk: [] },
			firstScoredAt: null,
		}))
		.on(routes.api.scoring.criteria, "$get", () => ({
			versions: [],
			activeVersion: null,
			template: "",
		}))
		.on(routes.api.calendar.criteria, "$get", () => ({
			versions: [],
			activeVersion: null,
			template: "",
		}))
		.on(routes.api.segments, "$get", () => ({ segments: [] }))
		.on(routes.api.datasets, "$get", () => ({ datasets: [] }));
}

/** 入力欄を1つずつ空欄にし、そのたびに画面が出ていることを確かめる */
function clearEachInput(view: ReturnType<typeof renderApp>, heading: string) {
	const inputs = () => [
		...view
			.getByRole("main")
			.querySelectorAll<HTMLInputElement>('input[type="text"]'),
	];
	expect(inputs().length).toBeGreaterThan(20);
	// 空欄にすると欄が増減することがあるので、毎回数え直す
	for (let i = 0; i < inputs().length; i++) {
		const input = inputs()[i] as HTMLInputElement;
		const label = input.getAttribute("aria-label") ?? `${i} 番目`;
		if (!input.disabled && !input.readOnly) changeValue(input, "");
		expect(
			view.queryByText("この画面を表示できなかった"),
			`「${label}」を空欄にしたとき`,
		).toBeNull();
		expect(
			view.queryByRole("heading", { level: 1, name: heading }),
			`「${label}」を空欄にしたとき`,
		).not.toBeNull();
	}
}

test("バックテストの実行画面は、入力欄を空欄にしても、その下書きで開き直しても落ちない", async () => {
	const first = renderApp("/backtest", robustApi());
	await first.findByLabelText("バックテスト名", {}, WAIT);
	const draft = JSON.parse(localStorage.getItem("backtest-draft") ?? "{}");
	localStorage.setItem(
		"backtest-draft",
		JSON.stringify({ ...draft, template: null, params: PARAMS }),
	);
	cleanup();

	const view = renderApp("/backtest", robustApi());
	await view.findByLabelText("バックテスト名", {}, WAIT);
	// 下書きの条件が読み込まれている
	expect(
		view.getByRole("main").querySelectorAll('input[type="text"]').length,
	).toBeGreaterThan(20);
	clearEachInput(view, "バックテスト");
	// 空欄にした値が下書きに残っている（開き直しで同じ値を読む）
	expect(
		JSON.parse(localStorage.getItem("backtest-draft") ?? "{}").params,
	).not.toEqual(PARAMS);
	cleanup();

	const again = renderApp("/backtest", robustApi());
	await again.findByLabelText("バックテスト名", {}, WAIT);
	expect(again.queryByText("この画面を表示できなかった")).toBeNull();
}, 30_000);

test("戦略の編集画面は、入力欄を空欄にしても落ちない", async () => {
	const view = renderApp("/strategies/1/edit", robustApi());
	await view.findByRole("heading", { name: "「空欄」の編集" }, WAIT);
	clearEachInput(view, "「空欄」の編集");
});
