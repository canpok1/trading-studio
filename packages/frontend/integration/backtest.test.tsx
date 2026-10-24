import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type {
	AdviceContent,
	BacktestAdvice,
	BacktestRun,
	CriteriaVersion,
	EventCriteriaVersion,
	HistoryEntry,
	InstructionsVersion,
	JudgmentCoverage,
	RescoreCoverage,
} from "@trading-studio/backend";
import type { Condition, ConditionSet } from "@trading-studio/core";
import { changeValue, setupDom } from "../src/shared/lib/test-setup";
import type { RunPageSetup } from "./backtest-fakes";
import {
	END,
	H,
	ORDERS,
	onResults,
	onRunPage,
	params,
	resultRun,
	START,
} from "./backtest-fakes";
import type { FakeApi } from "./fake-api";
import { createFakeApi, routes } from "./fake-api";
import { storedStrategy } from "./fixtures";

import { renderApp } from "./render-app";

setupDom();

afterEach(async () => {
	await new Promise((r) => setTimeout(r, 20));
	cleanup();
});
beforeEach(() => {
	localStorage.clear();
});

type View = ReturnType<typeof renderApp>;

/** 実行の終わりは 700ms ごとに問い合わせて知るので長めに待つ */
const RUN_WAIT = { timeout: 3_000 };

const runPageApi = (setup?: RunPageSetup) => onRunPage(createFakeApi(), setup);
const withResults = onResults;

const judgment = (values: string[]): Condition =>
	({ type: "judgment", judge: "sentiment", values }) as Condition;

type RunInput = {
	name: string;
	params: ConditionSet;
	from: number;
	to: number;
	skipGaps: boolean;
	criteriaVersion: number | null;
	eventCriteriaVersion: number | null;
};

/** 受けた条件で実行中の実行を作る */
function startRun(runs: Map<number, BacktestRun>, body: unknown): BacktestRun {
	const input = body as RunInput;
	const id = runs.size + 1;
	const run = resultRun({
		id,
		name: input.name,
		params: input.params,
		from: input.from,
		to: input.to,
		skipGaps: input.skipGaps,
		criteriaVersion: input.criteriaVersion,
		eventCriteriaVersion: input.eventCriteriaVersion,
		status: "running",
		progress: 0,
		orderCount: ORDERS.length,
		filledCount: ORDERS.length,
	});
	runs.set(id, run);
	return run;
}

function acceptRuns(api: FakeApi, runs: Map<number, BacktestRun>): FakeApi {
	return api.on(routes.api.backtests, "$post", ({ body }, reply) =>
		reply(202, { run: startRun(runs, body) }),
	);
}

async function openRunPage(api: FakeApi, from: string, to: string) {
	const view = renderApp("/backtest", api);
	await view.findByLabelText("バックテスト名");
	changeValue(view.getByLabelText("開始"), from);
	changeValue(view.getByLabelText("終了"), to);
	return view;
}

/** 条件を読み込むダイアログで選ぶ */
function pickTemplate(view: View, name: string, rename = false) {
	fireEvent.click(view.getByRole("button", { name: "条件を読み込む" }));
	const dialog = within(view.getByRole("dialog", { name: "条件を読み込む" }));
	if (rename) {
		fireEvent.click(
			dialog.getByLabelText("バックテスト名も読み込む戦略の名前にする"),
		);
	}
	fireEvent.click(dialog.getByRole("button", { name: new RegExp(`^${name}`) }));
}

const runButton = (view: View) =>
	view.getByRole("button", {
		name: /バックテストを実行|入力を直すと実行できる|の(採点|判断)がそろうと実行できる/,
	}) as HTMLButtonElement;

const sent = (api: FakeApi, method: string, path: string) =>
	api.requests.filter((r) => r.method === method && r.path === path);

describe("実行の画面", () => {
	test("条件を読み込むと足と本数が変わり、バックテスト名は選んだときだけ戦略の名前にする", async () => {
		const name = "高値抜け";
		const api = runPageApi({
			strategies: [storedStrategy({ id: 1, name, params: params() })],
		});
		const view = await openRunPage(api, "2026-05-03", "2026-05-25");
		const runName = view.getByLabelText("バックテスト名") as HTMLInputElement;
		changeValue(runName, "試し");
		expect(view.getByText(/1時間足 552 本/)).toBeTruthy();

		// 条件の足を変えると、使う足と本数も変わる
		fireEvent.change(view.getAllByLabelText("条件の足")[0] as HTMLElement, {
			target: { value: "4h" },
		});
		expect(view.getByText(/4時間足 138 本/)).toBeTruthy();
		expect(view.getByText("（変更あり）")).toBeTruthy();

		// 読み込み直すと条件は戻り、バックテスト名は変わらない
		pickTemplate(view, name);
		expect(view.getByText(/1時間足 552 本/)).toBeTruthy();
		expect(view.queryByText("（変更あり）")).toBeNull();
		expect(runName.value).toBe("試し");

		// 選んだときだけバックテスト名も戦略の名前にする。チェックは開くたびに外れている
		pickTemplate(view, name, true);
		expect(runName.value).toBe(name);
		fireEvent.click(view.getByRole("button", { name: "条件を読み込む" }));
		const dialog = within(view.getByRole("dialog", { name: "条件を読み込む" }));
		const rename = dialog.getByLabelText(
			"バックテスト名も読み込む戦略の名前にする",
		) as HTMLInputElement;
		expect(rename.checked).toBe(false);
		fireEvent.click(dialog.getByRole("button", { name: "やめる" }));
		expect(view.queryByRole("dialog")).toBeNull();
	});

	test("読み込んだ条件から変えて実行すると、その条件で実行し、終わったら結果の画面へ移る", async () => {
		const name = "高値抜け";
		const runs = new Map<number, BacktestRun>();
		const api = acceptRuns(
			withResults(
				runPageApi({
					strategies: [storedStrategy({ id: 1, name, params: params() })],
				}),
				runs,
			),
			runs,
		);
		const view = await openRunPage(api, "2026-05-03", "2026-05-25");
		changeValue(view.getByLabelText("バックテスト名"), "試し");
		fireEvent.click(view.getByRole("button", { name: "0.001 増やす" }));
		expect(view.getByText("（変更あり）")).toBeTruthy();
		fireEvent.click(runButton(view));

		expect(
			await view.findByText("試し", { exact: true }, RUN_WAIT),
		).toBeTruthy();
		expect(view.location.current).toBe("/backtest/runs/1");
		const input = sent(api, "POST", "/api/backtests")[0]?.body as RunInput;
		expect(input.name).toBe("試し");
		expect(input.params.buys[0]?.orderSize).toBe(1_100_000);
		expect([input.from, input.to]).toEqual([
			Date.UTC(2026, 4, 2, 15),
			Date.UTC(2026, 4, 25, 15),
		]);
	});

	test("上限を下げる前の保存済みの戦略・結果は、条件を変えなければ実行でき、変えると入力を直すまで実行できない", async () => {
		const old = params([
			{ type: "breakout", timeframe: "1h", lookback: 500, direction: "high" },
		]);
		const api = runPageApi({
			strategies: [storedStrategy({ id: 1, name: "古い", params: old })],
		});
		const view = await openRunPage(api, "2026-05-03", "2026-05-25");
		expect(runButton(view).textContent).toBe("バックテストを実行");
		fireEvent.click(view.getByRole("button", { name: "0.001 増やす" }));
		expect(runButton(view).textContent).toBe("入力を直すと実行できる");
		cleanup();

		const run = resultRun({ id: 8, name: "古い 試し", params: old });
		const rerun = withResults(runPageApi(), new Map([[run.id, run]]));
		const result = renderApp("/backtest/runs/8", rerun);
		fireEvent.click(
			(
				await result.findAllByRole("button", { name: "条件を変えて再実行" })
			)[0] as HTMLElement,
		);
		await result.findByLabelText("バックテスト名");
		expect(runButton(result).textContent).toBe("バックテストを実行");
		fireEvent.click(result.getByRole("button", { name: "0.001 増やす" }));
		expect(runButton(result).textContent).toBe("入力を直すと実行できる");
	});

	test("期間に欠損があると確認が出て、飛ばして実行できる", async () => {
		const runs = new Map<number, BacktestRun>();
		const api = withResults(runPageApi({ gap: true }), runs).on(
			routes.api.backtests,
			"$post",
			({ body }, reply) => {
				if ((body as RunInput).skipGaps) {
					return reply(202, { run: startRun(runs, body) });
				}
				return reply(409, {
					kind: "gaps",
					message: "期間内にデータの欠損がある",
					gaps: [{ from: START + 720 * H, to: START + 723 * H, missing: 3 }],
					gapCount: 1,
					missingBars: 3,
				});
			},
		);
		const view = await openRunPage(api, "2026-05-25", "2026-06-05");
		// 取り込み済みの範囲の帯に、色の意味を添える
		const legend = view
			.getAllByRole("list")
			.find((l) => l.textContent?.includes("選んだ期間"));
		expect(legend?.textContent).toContain("取り込み済み");
		expect(legend?.textContent).toContain("欠損（足が無い）");

		fireEvent.click(runButton(view));
		const alert = await view.findByRole("alert");
		expect(alert.textContent).toContain("期間内にデータの欠損がある");
		expect(alert.textContent).toContain("合計 3 本");
		fireEvent.click(
			within(alert).getByRole("button", { name: "欠損を飛ばして実行" }),
		);
		expect(
			await view.findByText(/欠損を飛ばして実行/, {}, RUN_WAIT),
		).toBeTruthy();
		expect(view.location.current).toBe("/backtest/runs/1");
	});

	test("判定の間隔より細かい過去データが無いと知らせる", async () => {
		// 1時間足までしか無いのに、保有中は15分ごとに判定する
		const p = params(undefined, {
			frequency: {
				flat: { value: 1, unit: "h" },
				holding: { value: 15, unit: "m" },
			},
		});
		const api = runPageApi({
			strategies: [storedStrategy({ id: 1, name: "細かい", params: p })],
		});
		const view = await openRunPage(api, "2026-05-03", "2026-05-25");
		expect(
			await view.findByText(
				/判定の間隔より細かい過去データが無いため、1時間足の終わりごとにしか判定しない/,
			),
		).toBeTruthy();
	});

	test("市場評価の条件がある戦略は、採点の記録が始まる前の期間では実行できず理由が出る", async () => {
		const api = runPageApi({
			strategies: [
				storedStrategy({
					id: 1,
					name: "判定",
					params: params([judgment(["+2", "+1"])]),
				}),
			],
			firstScoredAt: Date.UTC(2026, 4, 10),
		});
		const view = await openRunPage(api, "2026-05-03", "2026-05-25");
		expect(view.getByText(/市場評価の履歴を使う/)).toBeTruthy();
		expect(view.getByRole("alert").textContent).toMatch(
			/^市場評価の記録は .+ から/,
		);
		expect(runButton(view).disabled).toBe(true);
	});

	test("市場評価の条件で「データなし」を選んでいれば、採点の記録が無くても実行できる", async () => {
		const api = runPageApi({
			strategies: [
				storedStrategy({
					id: 1,
					name: "データなし",
					params: params([judgment(["+1", "none"])]),
				}),
			],
		});
		const view = await openRunPage(api, "2026-05-03", "2026-05-25");
		expect(view.getByText(/市場評価の履歴を使う/)).toBeTruthy();
		expect(view.queryByRole("alert")).toBeNull();
		expect(runButton(view).disabled).toBe(false);
	});

	test("相場データがまだ無いうちに相場データで期間を選ぶと、理由が出て実行できない", async () => {
		const view = await openRunPage(runPageApi(), "2026-05-03", "2026-05-25");
		fireEvent.click(view.getByRole("radio", { name: "相場データ" }));
		expect(view.getByText(/^相場データがまだ無い。/)).toBeTruthy();
		expect(view.queryByLabelText("開始")).toBeNull();
		expect(runButton(view).textContent).toBe("入力を直すと実行できる");
		expect(runButton(view).disabled).toBe(true);
		// 期間の指定へ戻すと日付の欄が戻る
		fireEvent.click(view.getByRole("radio", { name: "期間を指定" }));
		expect(view.getByLabelText("開始")).toBeTruthy();
	});

	test("相場データがまだ無いうちはデータセットを作れず、理由が出て実行できない", async () => {
		const view = await openRunPage(runPageApi(), "2026-05-03", "2026-05-25");
		fireEvent.click(view.getByRole("radio", { name: "データセット" }));
		expect(view.getByText(/^データセットがまだ無い。/)).toBeTruthy();
		expect(view.queryByLabelText("開始")).toBeNull();
		expect(runButton(view).disabled).toBe(true);
		fireEvent.click(view.getByRole("button", { name: "新しく作る" }));
		const dialog = view.getByRole("dialog", { name: "データセットを作る" });
		expect(within(dialog).getByText("相場データがまだ無い。")).toBeTruthy();
		expect(
			(
				within(dialog).getByRole("button", {
					name: "保存",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		fireEvent.click(within(dialog).getByRole("button", { name: "やめる" }));
		expect(view.queryByRole("dialog")).toBeNull();
	});
});

describe("採点の版", () => {
	const versions: CriteriaVersion[] = [
		{ version: 1, text: "基準", note: "初版", createdAt: START },
		{ version: 2, text: "基準2", note: "改善", createdAt: START },
	];
	const strategies = [
		storedStrategy({
			id: 1,
			name: "版",
			params: params([judgment(["+2", "+1", "0", "none"])]),
		}),
	];

	test("版を選ぶと、足りない記事を採点し直すまで実行できず、頼むと進み具合が出る", async () => {
		let coverage: RescoreCoverage = {
			total: 3,
			done: 0,
			pending: 0,
			failed: 0,
		};
		const api = runPageApi({
			strategies,
			firstScoredAt: START,
			criteriaVersions: versions,
		})
			.on(routes.api.scoring.rescore, "$get", () => ({ coverage }))
			.on(routes.api.scoring.rescore, "$post", () => {
				coverage = { ...coverage, pending: 3 };
				return { coverage };
			});
		const view = await openRunPage(api, "2026-05-03", "2026-05-25");
		fireEvent.change(view.getByLabelText("採点の版"), {
			target: { value: "2" },
		});
		const alert = await view.findByRole("alert");
		expect(alert.textContent).toContain("3 件に v2 の採点が無い");
		expect(runButton(view).textContent).toBe("v2 の採点がそろうと実行できる");
		expect(runButton(view).disabled).toBe(true);

		fireEvent.click(
			within(alert).getByRole("button", { name: "v2 で採点し直す" }),
		);
		expect((await view.findByRole("status")).textContent).toContain(
			"v2 で採点し直している: 0 / 3 件",
		);
		expect(sent(api, "POST", "/api/scoring/rescore")[0]?.body).toMatchObject({
			version: 2,
		});
		expect(runButton(view).disabled).toBe(true);
	});

	test("版の採点がそろうと実行でき、結果に版が出る", async () => {
		const runs = new Map<number, BacktestRun>();
		const api = acceptRuns(
			withResults(
				runPageApi({
					strategies,
					firstScoredAt: START,
					criteriaVersions: versions,
				}),
				runs,
			),
			runs,
		).on(routes.api.scoring.rescore, "$get", () => ({
			coverage: { total: 3, done: 3, pending: 0, failed: 0 },
		}));
		const view = await openRunPage(api, "2026-05-03", "2026-05-25");
		fireEvent.change(view.getByLabelText("採点の版"), {
			target: { value: "2" },
		});
		expect(await view.findByText("v2 の採点: 3 / 3 件")).toBeTruthy();
		fireEvent.click(runButton(view));
		const more = await view.findByRole(
			"button",
			{ name: /^他 \d+ 件/ },
			RUN_WAIT,
		);
		fireEvent.click(more);
		expect(view.getByRole("list", { name: "実行条件" }).textContent).toContain(
			"採点の版 v2",
		);
	});
});

describe("予定の評価基準の版", () => {
	const versions: EventCriteriaVersion[] = [
		{ version: 1, text: "基準", note: "初版", createdAt: START },
		{ version: 2, text: "基準2", note: "改善", createdAt: START },
	];
	const strategies = [
		storedStrategy({
			id: 1,
			name: "予定",
			params: params([
				{
					type: "eventWindow",
					minImportance: "high",
					beforeHours: 2,
					afterHours: 24,
					allowNoCalendar: false,
				},
			]),
		}),
	];

	test("予定の前後の条件があると版を選べ、判断がそろうまで実行できず、頼むと期間の前後を広げて送る", async () => {
		let coverage: JudgmentCoverage = {
			total: 4,
			done: 1,
			pending: 0,
			failed: 0,
		};
		const api = runPageApi({ strategies, eventCriteriaVersions: versions })
			.on(routes.api.calendar.judgments, "$get", () => ({ coverage }))
			.on(routes.api.calendar.judgments, "$post", () => {
				coverage = { ...coverage, pending: 3 };
				return { coverage };
			});
		const view = await openRunPage(api, "2026-05-03", "2026-05-25");
		const picker = view.getByLabelText(
			"予定の評価基準の版",
		) as HTMLSelectElement;
		expect(picker.selectedOptions[0]?.textContent).toBe("使用中の版（v2）");
		fireEvent.change(picker, { target: { value: "1" } });
		const alert = await view.findByRole("alert");
		expect(alert.textContent).toContain("3 件に v1 の重要度の判断が無い");
		expect(runButton(view).textContent).toBe(
			"予定の重要度の判断がそろうと実行できる",
		);
		fireEvent.click(
			within(alert).getByRole("button", { name: "v1 で先に判断する" }),
		);
		await waitFor(() =>
			expect(sent(api, "POST", "/api/calendar/judgments")).toHaveLength(1),
		);
		const body = sent(api, "POST", "/api/calendar/judgments")[0]?.body as {
			from: number;
			to: number;
			version: number;
		};
		expect(body.version).toBe(1);
		expect(body.to - body.from).toBe((22 + 1) * 24 * H + (2 + 24) * H);
		expect(runButton(view).disabled).toBe(true);
	});

	test("判断がそろうと実行でき、選んだ版を送り、結果に版が出る", async () => {
		const runs = new Map<number, BacktestRun>();
		const api = acceptRuns(
			withResults(
				runPageApi({ strategies, eventCriteriaVersions: versions }),
				runs,
			),
			runs,
		).on(routes.api.calendar.judgments, "$get", () => ({
			coverage: { total: 4, done: 3, pending: 0, failed: 1 },
		}));
		const view = await openRunPage(api, "2026-05-03", "2026-05-25");
		fireEvent.change(view.getByLabelText("予定の評価基準の版"), {
			target: { value: "1" },
		});
		expect(await view.findByText("v1 の重要度の判断: 3 / 4 件")).toBeTruthy();
		expect(
			view.getByText(/1 件は判断に失敗した。その前後は暦切れとして実行する/),
		).toBeTruthy();
		fireEvent.click(runButton(view));
		const more = await view.findByRole(
			"button",
			{ name: /^他 \d+ 件/ },
			RUN_WAIT,
		);
		expect(sent(api, "POST", "/api/backtests")[0]?.body).toMatchObject({
			eventCriteriaVersion: 1,
		});
		fireEvent.click(more);
		expect(view.getByRole("list", { name: "実行条件" }).textContent).toContain(
			"予定の評価基準 v1",
		);
	});
});

describe("結果の画面", () => {
	const run = resultRun({
		id: 7,
		name: "高値抜け 試し",
		params: params(),
		orderCount: ORDERS.length,
		filledCount: ORDERS.length,
		stepLimited: true,
	});

	test("成績と注文が出て、注文の詳細から対応する注文へ移れ、条件を新しい戦略に保存できる", async () => {
		const api = withResults(createFakeApi(), new Map([[run.id, run]])).on(
			routes.api.backtests[":id"].save,
			"$post",
			({ body }) => ({
				strategy: storedStrategy({
					id: 2,
					name: (body as { name: string }).name,
					params: run.params,
				}),
			}),
		);
		const view = renderApp("/backtest/runs/7", api);
		expect(await view.findByText(run.name, { exact: true })).toBeTruthy();
		expect(view.getByText(/1時間足で判定/)).toBeTruthy();
		// 判定の間隔より細かい足が無かった実行は知らせる
		expect(view.getByText(/1時間足の終わりごとにしか判定しない/)).toBeTruthy();
		const summary = within(view.getByRole("region", { name: "成績の要約" }));
		expect(summary.getByText("損益")).toBeTruthy();
		expect(summary.getByText("取引回数")).toBeTruthy();
		expect(summary.getAllByTestId("grade-badge").length).toBeGreaterThan(0);

		// 一覧から売りの約定を開き、対応する買いへ移る
		const orders = within(view.getByRole("region", { name: "注文と約定" }));
		fireEvent.click(await orders.findByRole("button", { name: /^売 / }));
		const sheet = view.getByRole("dialog", { name: "注文の詳細" });
		expect(sheet.textContent).toContain("戦略の理由");
		expect(sheet.textContent).toContain("売り · 約定");
		expect(within(sheet).getByTestId("exit-badge").textContent).toMatch(
			/^利確/,
		);
		fireEvent.click(
			within(sheet).getByRole("button", { name: /対応する買いを見る/ }),
		);
		await waitFor(() =>
			expect(
				view.getByRole("dialog", { name: "注文の詳細" }).textContent,
			).toContain("買い · 約定"),
		);
		fireEvent.click(view.getByRole("button", { name: "閉じる" }));
		expect(view.queryByRole("dialog")).toBeNull();

		// 条件は先頭だけ出し、広げると残りと保存のボタンが出る
		const conditions = view.getByRole("list", { name: "実行条件" });
		expect(within(conditions).getAllByRole("listitem")).toHaveLength(5);
		expect(
			view.queryByRole("button", { name: "新しい戦略として保存" }),
		).toBeNull();
		fireEvent.click(
			within(conditions).getByRole("button", { name: /^他 \d+ 件/ }),
		);
		expect(conditions.textContent).toContain("手数料");

		fireEvent.click(view.getByRole("button", { name: "新しい戦略として保存" }));
		const save = within(
			view.getByRole("dialog", { name: "新しい戦略として保存する" }),
		);
		const strategyName = save.getByLabelText("戦略の名前") as HTMLInputElement;
		expect(strategyName.value).toBe(run.name);
		changeValue(strategyName, "結果から");
		fireEvent.click(save.getByRole("button", { name: "保存" }));
		expect(
			await view.findByText("「結果から」として戦略に保存した"),
		).toBeTruthy();
		expect(sent(api, "POST", "/api/backtests/7/save")[0]?.body).toEqual({
			name: "結果から",
		});
	});

	test("期間の終わりに持っていた量を単位付きで知らせる", async () => {
		const base = resultRun({ id: 9, name: "保有で終わった" });
		const holding = {
			...base,
			summary: base.summary && {
				...base.summary,
				openPositionQuantity: 1_000_000,
			},
		};
		const view = renderApp(
			"/backtest/runs/9",
			withResults(createFakeApi(), new Map([[holding.id, holding]])),
		);
		expect(
			await view.findByText(/^期間の終わりに 0\.010 BTC を保有していた。/),
		).toBeTruthy();
	});

	test("「← 履歴」で履歴のタブへ戻り、名前で絞れ、「実行」のタブへ戻せる", async () => {
		const other = resultRun({ id: 8, name: "別の実行" });
		const api = withResults(
			runPageApi(),
			new Map([
				[run.id, run],
				[other.id, other],
			]),
		).on(routes.api.backtests.history, "$get", ({ query }) => {
			const q = query.get("q") ?? "";
			const entries: HistoryEntry[] = [run, other]
				.filter((r) => r.name.includes(q))
				.map((r) => ({ kind: "run", run: r }));
			return { entries, total: entries.length };
		});
		const view = renderApp("/backtest/runs/7", api);
		fireEvent.click(await view.findByRole("link", { name: "← 履歴" }));
		expect(view.location.current).toBe("/backtest?tab=history");
		expect(
			view.getByRole("tab", { name: "履歴" }).getAttribute("aria-selected"),
		).toBe("true");
		const history = within(view.getByRole("region", { name: "過去の実行" }));
		expect(await history.findByRole("link", { name: /別の実行/ })).toBeTruthy();

		// 名前で絞ると条件を URL に持ち、合わなければその旨を出す
		const search = history.getByRole("searchbox", { name: "名前で探す" });
		changeValue(search, "該当なし");
		expect(await history.findByText("条件に合う実行が無い。")).toBeTruthy();
		expect(view.location.current).toMatch(/[?&]q=/);
		changeValue(search, "試し");
		expect(
			await history.findByRole("link", { name: /高値抜け 試し/ }),
		).toBeTruthy();
		expect(history.queryByRole("link", { name: /別の実行/ })).toBeNull();

		// 履歴のタブに実行の画面は出さず、「実行」のタブへ戻せる
		expect(
			view.queryByRole("button", { name: "バックテストを実行" }),
		).toBeNull();
		fireEvent.click(view.getByRole("tab", { name: "実行" }));
		expect(view.location.current).toBe("/backtest");
		expect(view.queryByRole("region", { name: "過去の実行" })).toBeNull();
		expect(
			await view.findByRole("button", { name: "バックテストを実行" }),
		).toBeTruthy();
	});
});

describe("AI アドバイス", () => {
	const run = resultRun({ id: 7, name: "助言", params: params() });
	const improvedParams = params([
		{ type: "emaCross", timeframe: "1h", fast: 12, slow: 48, direction: "up" },
	]);
	const content: AdviceContent = {
		analysis: "デモの分析。注文は 2 件。",
		good: "- 良い",
		bad: "- 悪い",
		improvements: "- 改善案",
		improved: { ok: true, params: improvedParams },
	};
	const advice = (over: Partial<BacktestAdvice>): BacktestAdvice => ({
		runId: run.id,
		status: "done",
		content,
		model: "gemini-3.8-flash",
		instructionsVersion: 3,
		appBuiltAt: null,
		startedAt: START,
		finishedAt: START,
		error: null,
		...over,
	});
	const resultApi = () => withResults(runPageApi(), new Map([[run.id, run]]));

	test("ボタンで作り始め、できると中身が出て、作り直している間も前の中身を残す", async () => {
		let current: BacktestAdvice | null = null;
		const api = resultApi()
			.on(routes.api.advice.runs[":id"], "$get", () => {
				// 作成中は次の問い合わせでできあがる
				if (current?.status === "running") current = advice({});
				return { advice: current };
			})
			.on(routes.api.advice.runs[":id"], "$post", () => {
				current = advice({
					status: "running",
					content: current?.content ?? null,
				});
				return { advice: current };
			});
		const view = renderApp("/backtest/runs/7", api);
		const section = within(
			await view.findByRole("region", { name: "AI アドバイス" }),
		);
		fireEvent.click(
			await section.findByRole("button", { name: "アドバイスを作る" }),
		);
		expect(await section.findByRole("status", { name: "作成中" })).toBeTruthy();

		// 作成中は 3 秒ごとに問い合わせる
		const body = await section.findByTestId(
			"advice-content",
			{},
			{ timeout: 4_000 },
		);
		expect(body.textContent).toContain("デモの分析。注文は 2 件。");
		expect(body.textContent).toContain("改善案");
		expect(body.textContent).toContain("指示 v3");

		fireEvent.click(section.getByRole("button", { name: "作り直す" }));
		expect(
			(await section.findByRole("status", { name: "作成中" })).textContent,
		).toContain("終わると下のアドバイスを置き換える");
		expect(section.getByTestId("advice-content").textContent).toContain(
			"デモの分析",
		);
	}, 10_000);

	test("改善版でバックテストすると、期間はそのまま、改善版の条件と変更点が入った実行の画面へ移る", async () => {
		const api = resultApi().on(routes.api.advice.runs[":id"], "$get", () => ({
			advice: advice({}),
		}));
		const view = renderApp("/backtest/runs/7", api);
		fireEvent.click(
			await view.findByRole("button", { name: "改善版でバックテストする" }),
		);
		const changes = await view.findByRole("region", {
			name: "AI の改善版の変更点",
		});
		expect(view.location.current).toBe("/backtest");
		expect(
			(view.getByLabelText("バックテスト名") as HTMLInputElement).value,
		).toBe("助言（改善版）");
		expect((view.getByLabelText("開始") as HTMLInputElement).value).toBe(
			"2026-05-03",
		);
		expect((view.getByLabelText("終了") as HTMLInputElement).value).toBe(
			"2026-05-25",
		);
		expect(changes.textContent).toContain(
			"変更前: 1時間足で 終値が直近 5 本の最高値を上抜けた",
		);
		expect(changes.textContent).toContain(
			"変更後: 1時間足で 短期EMA 12 本が 長期EMA 48 本を上抜けた",
		);
		fireEvent.click(within(changes).getByRole("button", { name: "閉じる" }));
		expect(
			view.queryByRole("region", { name: "AI の改善版の変更点" }),
		).toBeNull();
	});

	test("別の AI の答えを貼ると、アドバイスとして取り込める", async () => {
		let current: BacktestAdvice | null = null;
		const api = resultApi()
			.on(routes.api.advice.runs[":id"], "$get", () => ({ advice: current }))
			.on(routes.api.advice.runs[":id"]["external-prompt"], "$get", () => ({
				prompt: "指示の本文",
				file: { name: "backtest-7.md", content: "資料" },
				instructionsVersion: 3,
			}))
			.on(routes.api.advice.runs[":id"].import, "$post", ({ body }, reply) => {
				const input = body as { text: string; model: string };
				if (!input.text.includes("{")) {
					return reply(400, { message: "答えに JSON が無い" });
				}
				current = advice({
					model: input.model,
					content: {
						...content,
						analysis: "外の AI の分析",
						improved: { ok: false, reason: "AI の応答に改善版の戦略が無い" },
					},
				});
				return { advice: current };
			});
		const view = renderApp("/backtest/runs/7", api);
		fireEvent.click(
			await view.findByRole("button", { name: "別の AI で作る" }),
		);
		const dialog = within(view.getByRole("dialog", { name: "別の AI で作る" }));
		expect(await dialog.findByText(/指示 v3（\d+ 文字）/)).toBeTruthy();

		const answer = dialog.getByLabelText(/返ってきた答え/);
		changeValue(answer, "答えではない");
		fireEvent.click(dialog.getByRole("button", { name: "取り込む" }));
		expect((await dialog.findByRole("alert")).textContent).toContain(
			"JSON が無い",
		);

		changeValue(answer, '```json\n{"analysis": "外の AI の分析"}\n```');
		changeValue(dialog.getByLabelText("使った AI の名前（任意）"), "ChatGPT");
		fireEvent.click(dialog.getByRole("button", { name: "取り込む" }));
		const body = await view.findByTestId("advice-content");
		expect(view.queryByRole("dialog")).toBeNull();
		expect(body.textContent).toContain("外の AI の分析");
		expect(body.textContent).toContain("ChatGPT");
		expect(body.textContent).toContain("AI の応答に改善版の戦略が無い");
		expect(
			sent(api, "POST", "/api/advice/runs/7/import").at(-1)?.body,
		).toMatchObject({ model: "ChatGPT", instructionsVersion: 3 });
	});
});

describe("設定の「バックテスト」", () => {
	test("アドバイスのモデルと指示の版を変えられる", async () => {
		let model = "gemini-3.8-flash";
		const versions: InstructionsVersion[] = [
			{ version: 1, text: "- 初版", note: "初版", createdAt: START },
		];
		let active = 1;
		const models = () => ({
			models: [
				{ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
				{
					id: "gemini-3.1-pro-preview",
					label: "Gemini 3.1 Pro（プレビュー）",
				},
			],
			current: model,
		});
		const instructions = () => ({
			versions,
			activeVersion: active,
			template: "{backtest}\n{instructions}",
		});
		const api = createFakeApi()
			.on(routes.api.advice.model, "$get", models)
			.on(routes.api.advice.model, "$put", ({ body }) => {
				model = (body as { model: string }).model;
				return models();
			})
			.on(routes.api.ai.compatible.models, "$get", () => ({
				ok: false,
				message: "接続先が無い",
			}))
			.on(routes.api.advice.instructions, "$get", instructions)
			.on(routes.api.advice.instructions, "$post", ({ body }) => {
				const { text, note } = body as { text: string; note: string };
				const version = {
					version: versions.length + 1,
					text,
					note,
					createdAt: END,
				};
				versions.push(version);
				return { version };
			})
			.on(routes.api.advice.instructions.active, "$put", ({ body }) => {
				active = (body as { version: number }).version;
				return instructions();
			});
		const view = renderApp("/settings?section=backtest", api);

		const picker = (await view.findByLabelText(
			"アドバイスに使うモデル",
		)) as HTMLInputElement;
		await view.findByDisplayValue("Gemini 3.8 Flash");
		fireEvent.click(picker);
		fireEvent.click(
			view.getByRole("option", { name: "Gemini 3.1 Pro（プレビュー）" }),
		);
		fireEvent.click(
			view.getAllByRole("button", { name: "保存" })[0] as HTMLElement,
		);
		expect(await view.findByText(/^モデルを保存した/)).toBeTruthy();
		expect(model).toBe("gemini-3.1-pro-preview");

		changeValue(await view.findByLabelText(/^指示/), "- 新しい指示");
		fireEvent.click(view.getByRole("button", { name: "v2 として保存" }));
		expect(await view.findByText(/^v2 を保存した/)).toBeTruthy();
		const v2 = within(await view.findByTestId("instructions-v2"));
		fireEvent.click(v2.getByRole("button", { name: "使用する" }));
		expect(await v2.findByText("使用中")).toBeTruthy();
		expect(active).toBe(2);
	});
});
