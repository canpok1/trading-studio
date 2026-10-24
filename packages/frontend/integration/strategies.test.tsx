import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type { StoredStrategy } from "@trading-studio/backend";
import { strategyTemplate } from "@trading-studio/core";
import { changeValue, setupDom } from "../src/shared/lib/test-setup";
import type { FakeApi } from "./fake-api";
import { createFakeApi, routes } from "./fake-api";
import { storedStrategy, tradingRun } from "./fixtures";
import { renderApp } from "./render-app";

setupDom();

afterEach(async () => {
	await new Promise((r) => setTimeout(r, 20));
	cleanup();
});

/** 戦略を覚えておく偽物の API。保存した条件を、画面を開き直して確かめるのに使う */
function strategiesApi(): FakeApi {
	const store = new Map<number, StoredStrategy>();
	let nextId = 1;
	const duplicate = (name: string, self?: number) =>
		[...store.values()].some((s) => s.name === name && s.id !== self);
	const DUPLICATE = {
		message: "同じ名前の戦略がある。別の名前にする",
		field: "name",
	} as const;
	const NOT_FOUND = { message: "戦略が見つからない" };
	return createFakeApi()
		.on(routes.api.data.latest, "$get", () => ({ latest: null }))
		.on(routes.api.strategies, "$get", () => ({
			strategies: [...store.values()],
		}))
		.on(routes.api.trading.strategies, "$get", () => ({
			strategies: [...store.values()].map((s) =>
				tradingRun({ id: s.id, name: s.name }),
			),
		}))
		.on(routes.api.strategies, "$post", (req, reply) => {
			const { name, from } = req.body as {
				name: string;
				from: { template: "trend" | "range" | "blank" } | { copyOf: number };
			};
			if (duplicate(name)) return reply(409, DUPLICATE);
			const params =
				"template" in from
					? strategyTemplate(from.template).params
					: store.get(from.copyOf)?.params;
			if (!params) return reply(404, NOT_FOUND);
			const s = storedStrategy({ id: nextId++, name, params });
			store.set(s.id, s);
			return { strategy: s };
		})
		.on(routes.api.strategies[":id"].params, "$put", (req, reply) => {
			const s = store.get(Number(req.params.id));
			if (!s) return reply(404, NOT_FOUND);
			const saved = {
				...s,
				params: (req.body as { params: StoredStrategy["params"] }).params,
			};
			store.set(s.id, saved);
			return { strategy: saved };
		})
		.on(routes.api.strategies[":id"].name, "$put", (req, reply) => {
			const s = store.get(Number(req.params.id));
			if (!s) return reply(404, NOT_FOUND);
			const name = (req.body as { name: string }).name;
			if (duplicate(name, s.id)) return reply(409, DUPLICATE);
			const renamed = { ...s, name };
			store.set(s.id, renamed);
			return { strategy: renamed };
		})
		.on(routes.api.strategies[":id"], "$delete", (req, reply) =>
			store.delete(Number(req.params.id))
				? { ok: true as const }
				: reply(404, NOT_FOUND),
		);
}

type View = ReturnType<typeof renderApp>;

const value = (el: HTMLElement) => (el as HTMLInputElement).value;
const checked = (el: HTMLElement) => (el as HTMLInputElement).checked;
const disabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled;

/** 1件で保存・読み直しを何度も通すので、混んだ環境では既定の 1 秒を超えることがある */
const wait = { timeout: 3000 };

async function statusIs(view: View, text: string) {
	await waitFor(
		() => expect(view.getByRole("status").textContent).toBe(text),
		wait,
	);
}

async function open(api: FakeApi) {
	const view = renderApp("/strategies", api);
	await view.findByRole("button", { name: "＋ 新しい戦略" }, wait);
	return view;
}

async function createFromTemplate(view: View, name: string, template: RegExp) {
	fireEvent.click(view.getByRole("button", { name: "＋ 新しい戦略" }));
	const dialog = within(view.getByRole("dialog", { name: "新しい戦略" }));
	changeValue(dialog.getByLabelText("名前"), name);
	fireEvent.click(dialog.getByRole("button", { name: template }));
	await opened(view, name);
}

/**
 * 戦略の編集画面を開き終えるまで待つ。作った戦略は編集画面で開き、
 * 編集中の下書きは開いた後の effect で入るので、その前に打つと上書きされる
 */
async function opened(view: View, name: string) {
	await view.findByRole("heading", { name: `「${name}」の編集` }, wait);
	await new Promise((r) => setTimeout(r, 0));
}

/** 編集している戦略の名前 */
function editingName(view: View) {
	const h = view.getByRole("heading", { level: 1 }).textContent ?? "";
	return h.replace(/^「(.*)」の編集$/, "$1");
}

async function save(view: View) {
	fireEvent.click(view.getByRole("button", { name: "保存" }));
	await statusIs(view, "保存した");
}

/** ブラウザの再読み込みに当たる。偽物の API が覚えている戦略を読み直す */
async function reopen(view: View) {
	const path = view.location.current;
	const name = editingName(view);
	cleanup();
	const again = renderApp(path, view.api);
	await opened(again, name);
	return again;
}

const region = (view: View | ReturnType<typeof within>, name: string) =>
	within(view.getByRole("region", { name }));

/** 条件の組（買い・利確・損切りなど）へ条件を足す */
function addCondition(view: View, group: string, name: string | RegExp) {
	fireEvent.click(
		region(view, group).getByRole("button", { name: "＋ 条件を追加" }),
	);
	fireEvent.click(
		within(view.getByRole("dialog")).getByRole("button", { name }),
	);
}

/** label の付いた欄を持つ条件の行 */
function row(view: View, group: string, label: string) {
	const field = region(view, group).getByLabelText(label);
	return within(field.closest("fieldset") as HTMLElement);
}

const blocked = (view: View) =>
	disabled(view.getByRole("button", { name: "入力を直すと保存できる" }));

describe("戦略の編集", () => {
	test("ひな形から作った戦略の条件を変えて保存すると、開き直しても残る", async () => {
		let view = await open(strategiesApi());
		await createFromTemplate(view, "トレンド", /^トレンド追随/);
		expect(disabled(view.getByRole("button", { name: "変更なし" }))).toBe(true);

		changeValue(
			view.getAllByLabelText("長期EMA の本数")[0] as HTMLElement,
			"60",
		);
		changeValue(
			region(view, "売り注文（損切り）する条件").getByLabelText("買値からの %"),
			"3",
		);
		await save(view);

		view = await reopen(view);
		expect(
			value(view.getAllByLabelText("長期EMA の本数")[0] as HTMLElement),
		).toBe("60");
		expect(
			value(
				region(view, "売り注文（損切り）する条件").getByLabelText(
					"買値からの %",
				),
			),
		).toBe("3");
	});

	test("入力を誤ると保存できず、元に戻すと保存前の値に戻る", async () => {
		const view = await open(strategiesApi());
		await createFromTemplate(view, "誤り", /^トレンド追随/);
		const pct = () =>
			region(view, "売り注文（損切り）する条件").getByLabelText("買値からの %");
		changeValue(pct(), "");
		expect(pct().getAttribute("aria-invalid")).toBe("true");
		expect(blocked(view)).toBe(true);
		fireEvent.click(view.getByRole("button", { name: "元に戻す" }));
		expect(value(pct())).toBe("2");
		expect(disabled(view.getByRole("button", { name: "変更なし" }))).toBe(true);
	});

	test("市場評価の条件を足すと危機以外が選ばれ、1つも選ばないと保存できない", async () => {
		let view = await open(strategiesApi());
		await createFromTemplate(view, "判定", /^トレンド追随/);
		addCondition(view, "買い注文する条件", "リスクが指定のどれか");
		const risk = () => row(view, "買い注文する条件", "危機");
		const safe = ["平常", "やや警戒", "警戒", "かなり警戒"];
		for (const v of safe) expect(checked(risk().getByLabelText(v))).toBe(true);
		expect(checked(risk().getByLabelText("危機"))).toBe(false);

		for (const v of safe) fireEvent.click(risk().getByLabelText(v));
		expect(risk().getByText("1つ以上選ぶ")).toBeTruthy();
		expect(blocked(view)).toBe(true);

		fireEvent.click(risk().getByLabelText("平常"));
		await save(view);
		view = await reopen(view);
		expect(checked(risk().getByLabelText("平常"))).toBe(true);
		expect(checked(risk().getByLabelText("警戒"))).toBe(false);
	});

	test("RSI の条件を足すと既定値が入り、しきい値が範囲外だと保存できない", async () => {
		let view = await open(strategiesApi());
		await createFromTemplate(view, "RSI", /^トレンド追随/);
		addCondition(view, "買い注文する条件", /^RSI$/);
		const rsi = () => row(view, "買い注文する条件", "以上・以下");
		expect(value(rsi().getByLabelText("RSI の本数"))).toBe("14");
		expect(value(rsi().getByLabelText("RSI のしきい値"))).toBe("30");
		expect(value(rsi().getByLabelText("以上・以下"))).toBe("below");

		changeValue(rsi().getByLabelText("RSI のしきい値"), "100");
		expect(rsi().getByText("1〜99 の整数で入れる")).toBeTruthy();
		expect(blocked(view)).toBe(true);

		changeValue(rsi().getByLabelText("RSI のしきい値"), "25");
		await save(view);
		view = await reopen(view);
		expect(value(rsi().getByLabelText("RSI のしきい値"))).toBe("25");
	});

	test("EMA の傾きの条件を足すと既定値が入り、% が 0.01 刻みでなければ保存できない", async () => {
		let view = await open(strategiesApi());
		await createFromTemplate(view, "傾き", /^トレンド追随/);
		addCondition(view, "買い注文する条件", "EMA の傾き");
		const slope = () => row(view, "買い注文する条件", "何本前と比べるか");
		expect(value(slope().getByLabelText("EMA の本数"))).toBe("50");
		expect(value(slope().getByLabelText("何本前と比べるか"))).toBe("5");
		expect(value(slope().getByLabelText("傾きの %"))).toBe("0");
		expect(value(slope().getByLabelText("上下"))).toBe("up");

		changeValue(slope().getByLabelText("傾きの %"), "0.005");
		expect(slope().getByText("0〜100、0.01 刻みで入れる")).toBeTruthy();
		expect(blocked(view)).toBe(true);

		changeValue(slope().getByLabelText("傾きの %"), "0.25");
		await save(view);
		view = await reopen(view);
		expect(value(slope().getByLabelText("傾きの %"))).toBe("0.25");
	});

	test("RSI のクロスの条件と損切り後に買わない本数を保存でき、範囲外は保存できない", async () => {
		let view = await open(strategiesApi());
		await createFromTemplate(view, "反発", /^トレンド追随/);
		addCondition(view, "買い注文する条件", "RSI のクロス");
		const cross = () => row(view, "買い注文する条件", "何本以内に抜けたか");
		expect(value(cross().getByLabelText("RSI の本数"))).toBe("14");
		expect(value(cross().getByLabelText("RSI のしきい値"))).toBe("30");
		expect(value(cross().getByLabelText("クロスの向き"))).toBe("up");
		expect(value(cross().getByLabelText("何本以内に抜けたか"))).toBe("1");
		changeValue(cross().getByLabelText("何本以内に抜けたか"), "3");

		const cooldown = () => view.getByLabelText("損切り後に買わない本数");
		expect(value(cooldown())).toBe("0");
		changeValue(cooldown(), "6");
		await save(view);
		view = await reopen(view);
		expect(value(cross().getByLabelText("何本以内に抜けたか"))).toBe("3");
		expect(value(cooldown())).toBe("6");

		changeValue(cooldown(), "1001");
		expect(cooldown().getAttribute("aria-invalid")).toBe("true");
		expect(blocked(view)).toBe(true);
	});

	test("終値と EMA の位置・ボリンジャーバンド・最高値からの %・買ってからの本数を足して保存でき、買いには売り専用の条件が出ない", async () => {
		let view = await open(strategiesApi());
		await createFromTemplate(view, "条件追加", /^トレンド追随/);
		const buy = "買い注文する条件";
		const tp = "売り注文（利確）する条件";
		const sl = "売り注文（損切り）する条件";

		fireEvent.click(
			region(view, buy).getByRole("button", { name: "＋ 条件を追加" }),
		);
		const dialog = within(view.getByRole("dialog"));
		expect(
			dialog.queryAllByRole("button", { name: /トレーリングストップ/ }),
		).toHaveLength(0);
		expect(
			dialog.queryAllByRole("button", { name: "買ってからの本数" }),
		).toHaveLength(0);
		fireEvent.click(dialog.getByRole("button", { name: "やめる" }));

		addCondition(view, buy, "終値と EMA の位置");
		const position = () => row(view, buy, "EMA の本数");
		expect(value(position().getByLabelText("EMA の本数"))).toBe("200");
		expect(value(position().getByLabelText("上下"))).toBe("above");
		addCondition(view, buy, "ボリンジャーバンド");
		const bb = () => region(view, buy);
		expect(value(bb().getByLabelText("ボリンジャーバンドの本数"))).toBe("20");
		expect(value(bb().getByLabelText("ボリンジャーバンドの σ"))).toBe("2");
		expect(value(bb().getByLabelText("上限・下限"))).toBe("lower");

		addCondition(view, tp, "買ってからの本数");
		expect(value(region(view, tp).getByLabelText("買ってからの本数"))).toBe(
			"24",
		);
		addCondition(view, sl, /トレーリングストップ/);
		expect(value(region(view, sl).getByLabelText("最高値からの %"))).toBe("3");

		changeValue(bb().getByLabelText("ボリンジャーバンドの σ"), "2.55");
		expect(bb().getByText("0.1〜5、0.1 刻みで入れる")).toBeTruthy();
		expect(blocked(view)).toBe(true);
		changeValue(bb().getByLabelText("ボリンジャーバンドの σ"), "2.5");
		changeValue(region(view, sl).getByLabelText("最高値からの %"), "5");
		await save(view);

		view = await reopen(view);
		expect(
			value(region(view, buy).getByLabelText("ボリンジャーバンドの σ")),
		).toBe("2.5");
		expect(value(region(view, sl).getByLabelText("最高値からの %"))).toBe("5");
		expect(value(region(view, tp).getByLabelText("買ってからの本数"))).toBe(
			"24",
		);
	});

	test("買値・最高値からの ATR の倍数を既定値で足して保存でき、倍数が 0.1 刻みでなければ保存できない", async () => {
		let view = await open(strategiesApi());
		await createFromTemplate(view, "ATR", /^トレンド追随/);
		const tp = "売り注文（利確）する条件";
		const sl = "売り注文（損切り）する条件";

		addCondition(view, tp, "買値からの ATR の倍数");
		const entry = () => row(view, tp, "ATR の本数");
		expect(value(entry().getByLabelText("ATR の足"))).toBe("1h");
		expect(value(entry().getByLabelText("ATR の本数"))).toBe("14");
		expect(value(entry().getByLabelText("ATR の倍数"))).toBe("3");
		expect(value(entry().getByLabelText("上下"))).toBe("up");
		addCondition(view, sl, "買ってからの最高値からの ATR の倍数");
		const trail = () => row(view, sl, "ATR の本数");
		expect(value(trail().getByLabelText("ATR の倍数"))).toBe("3");
		expect(
			value(trail().getByLabelText("発動する最高値の買値からの ATR の倍数")),
		).toBe("0");

		changeValue(trail().getByLabelText("ATR の倍数"), "2.55");
		expect(trail().getByText("0.1〜20、0.1 刻みで入れる")).toBeTruthy();
		expect(blocked(view)).toBe(true);
		changeValue(trail().getByLabelText("ATR の倍数"), "2.5");
		changeValue(
			trail().getByLabelText("発動する最高値の買値からの ATR の倍数"),
			"1",
		);
		await save(view);

		view = await reopen(view);
		expect(value(region(view, tp).getByLabelText("ATR の倍数"))).toBe("3");
		expect(value(region(view, sl).getByLabelText("ATR の倍数"))).toBe("2.5");
		expect(
			value(
				region(view, sl).getByLabelText(
					"発動する最高値の買値からの ATR の倍数",
				),
			),
		).toBe("1");
	});

	test("ADX を買いと売りに足すと既定は 14 本・20 以上/以下になり、範囲外のしきい値は保存できない", async () => {
		let view = await open(strategiesApi());
		await createFromTemplate(view, "ADX", /^トレンド追随/);
		const buy = "買い注文する条件";
		const sl = "売り注文（損切り）する条件";

		addCondition(view, buy, /^ADX/);
		const b = () => row(view, buy, "ADX の本数");
		expect(value(b().getByLabelText("ADX の本数"))).toBe("14");
		expect(value(b().getByLabelText("ADX のしきい値"))).toBe("20");
		expect(value(b().getByLabelText("以上・以下"))).toBe("above");
		addCondition(view, sl, /^ADX/);
		const s = () => row(view, sl, "ADX の本数");
		expect(value(s().getByLabelText("以上・以下"))).toBe("below");

		changeValue(b().getByLabelText("ADX のしきい値"), "100");
		expect(b().getByText("1〜99 の整数で入れる")).toBeTruthy();
		expect(blocked(view)).toBe(true);
		changeValue(b().getByLabelText("ADX のしきい値"), "25");
		await save(view);

		view = await reopen(view);
		expect(value(b().getByLabelText("ADX のしきい値"))).toBe("25");
		expect(value(s().getByLabelText("以上・以下"))).toBe("below");
	});

	test("DVOL は買いと売りに出て、既定は平均との比（30 日・120% 以下/150% 以上）。値に切り替えて保存できる", async () => {
		let view = await open(strategiesApi());
		await createFromTemplate(view, "DVOL", /^トレンド追随/);
		const buy = "買い注文する条件";
		const sl = "売り注文（損切り）する条件";

		addCondition(view, buy, /^DVOL/);
		const b = () => row(view, buy, "DVOL の見方");
		expect(value(b().getByLabelText("DVOL の見方"))).toBe("dvolAverage");
		expect(value(b().getByLabelText("DVOL の平均を取る日数"))).toBe("30");
		expect(value(b().getByLabelText("DVOL の平均に対する %"))).toBe("120");
		expect(value(b().getByLabelText("以上・以下"))).toBe("below");
		addCondition(view, sl, /^DVOL/);
		const s = () => row(view, sl, "DVOL の見方");
		expect(value(s().getByLabelText("DVOL の平均に対する %"))).toBe("150");
		expect(value(s().getByLabelText("以上・以下"))).toBe("above");

		changeValue(b().getByLabelText("DVOL の平均を取る日数"), "31");
		expect(b().getByText("1〜30 の整数で入れる")).toBeTruthy();
		expect(blocked(view)).toBe(true);
		fireEvent.change(b().getByLabelText("DVOL の見方"), {
			target: { value: "dvol" },
		});
		expect(value(b().getByLabelText("DVOL のしきい値"))).toBe("60");
		expect(value(b().getByLabelText("以上・以下"))).toBe("below");
		changeValue(b().getByLabelText("DVOL のしきい値"), "55.5");
		await save(view);

		view = await reopen(view);
		expect(value(b().getByLabelText("DVOL の見方"))).toBe("dvol");
		expect(value(b().getByLabelText("DVOL のしきい値"))).toBe("55.5");
		expect(value(s().getByLabelText("DVOL の見方"))).toBe("dvolAverage");
	});

	test("予定の前後は買いだけに出て、既定は重要度 高・後 24 時間。範囲外の時間は保存できない", async () => {
		let view = await open(strategiesApi());
		await createFromTemplate(view, "イベント", /^トレンド追随/);
		const buy = "買い注文する条件";
		fireEvent.click(
			region(view, "売り注文（損切り）する条件").getByRole("button", {
				name: "＋ 条件を追加",
			}),
		);
		expect(
			within(view.getByRole("dialog")).queryByRole("button", {
				name: "予定の前後でない",
			}),
		).toBeNull();
		fireEvent.click(
			within(view.getByRole("dialog")).getByRole("button", { name: "やめる" }),
		);

		addCondition(view, buy, "予定の前後でない");
		const ev = () => row(view, buy, "予定の何時間後まで");
		expect(value(ev().getByLabelText("予定の重要度"))).toBe("high");
		expect(value(ev().getByLabelText("予定の何時間前から"))).toBe("0");
		expect(value(ev().getByLabelText("予定の何時間後まで"))).toBe("24");
		expect(checked(ev().getByLabelText("暦切れのときも成立とみなす"))).toBe(
			false,
		);

		changeValue(ev().getByLabelText("予定の何時間後まで"), "169");
		expect(ev().getByText("0〜168 の整数で入れる")).toBeTruthy();
		expect(blocked(view)).toBe(true);
		changeValue(ev().getByLabelText("予定の何時間後まで"), "48");
		fireEvent.change(ev().getByLabelText("予定の重要度"), {
			target: { value: "medium" },
		});
		fireEvent.click(ev().getByLabelText("暦切れのときも成立とみなす"));
		await save(view);

		view = await reopen(view);
		expect(value(ev().getByLabelText("予定の何時間後まで"))).toBe("48");
		expect(value(ev().getByLabelText("予定の重要度"))).toBe("medium");
		expect(checked(ev().getByLabelText("暦切れのときも成立とみなす"))).toBe(
			true,
		);
	});

	test("一部利確の条件と売り方、トレーリングストップの発動を保存でき、残りが下限を下回る割合は保存できない", async () => {
		let view = await open(strategiesApi());
		await createFromTemplate(view, "一部利確", /^トレンド追随/);
		const name = "売り注文（一部利確）する条件";
		const ptp = () => region(view, name);
		expect(ptp().queryAllByLabelText("一部利確で売る割合")).toHaveLength(0);
		addCondition(view, name, /トレーリングストップ/);
		expect(value(ptp().getByLabelText("一部利確で売る割合"))).toBe("50");
		expect(checked(ptp().getByRole("checkbox"))).toBe(true);
		const text = () => view.getByRole("region", { name }).textContent as string;
		expect(text()).toContain("0.010 BTC を売り、0.010 BTC を残す");

		changeValue(view.getByLabelText("1回の注文量（BTC）"), "0.0015");
		expect(text()).toContain("どちらも 0.001 BTC 以上になるようにする");
		expect(blocked(view)).toBe(true);
		changeValue(view.getByLabelText("1回の注文量（BTC）"), "0.0025");
		changeValue(ptp().getByLabelText("発動する最高値の買値からの %"), "3");
		fireEvent.click(ptp().getByRole("checkbox"));
		await save(view);

		view = await reopen(view);
		expect(value(ptp().getByLabelText("発動する最高値の買値からの %"))).toBe(
			"3",
		);
		expect(checked(ptp().getByRole("checkbox"))).toBe(false);
		expect(text()).toContain("0.00125 BTC を売り、0.00125 BTC を残す");
	});

	test("1日の損失上限を変えて保存でき、0 円は保存できない", async () => {
		let view = await open(strategiesApi());
		await createFromTemplate(view, "損失上限", /^トレンド追随/);
		const limit = () => view.getByLabelText("1日の損失上限（円）");
		expect(value(limit())).toBe("30,000");
		changeValue(limit(), "50000");
		await save(view);
		view = await reopen(view);
		expect(value(limit())).toBe("50,000");

		changeValue(limit(), "0");
		expect(limit().getAttribute("aria-invalid")).toBe("true");
		expect(blocked(view)).toBe(true);
	});
});

describe("買いの注文の出し方", () => {
	test("指値に変えて値幅と本数を保存でき、成行では入力欄を出さない", async () => {
		let view = await open(strategiesApi());
		await createFromTemplate(view, "注文方法", /^トレンド追随/);
		const buy = () => region(view, "買い注文する条件");
		const below = () => buy().getByLabelText("1件目の指値を現在値から下げる %");
		// トレンド追随のひな形は成行
		expect(checked(buy().getByRole("radio", { name: "成行" }))).toBe(true);
		expect(
			buy().queryAllByLabelText("1件目の指値を現在値から下げる %"),
		).toHaveLength(0);

		fireEvent.click(buy().getByRole("radio", { name: "指値" }));
		changeValue(below(), "0.5");
		changeValue(buy().getByLabelText("指値を取り消すまでの本数"), "6");
		await save(view);

		view = await reopen(view);
		expect(checked(buy().getByRole("radio", { name: "指値" }))).toBe(true);
		expect(value(below())).toBe("0.5");
		expect(value(buy().getByLabelText("指値を取り消すまでの本数"))).toBe("6");

		changeValue(below(), "100");
		expect(below().getAttribute("aria-invalid")).toBe("true");
		expect(blocked(view)).toBe(true);
	});

	test("最大ロット数と指値の行を足して保存でき、逆順の % は保存できない", async () => {
		let view = await open(strategiesApi());
		await createFromTemplate(view, "複数ポジション", /^レンジ逆張り/);
		changeValue(view.getByLabelText("最大ロット数"), "3");
		const buy = () => region(view, "買い注文する条件");
		fireEvent.click(buy().getByRole("button", { name: "＋ 指値を追加" }));
		const second = () =>
			buy().getByLabelText("2件目の指値を現在値から下げる %");
		expect(value(second())).toBe("0.6");
		changeValue(second(), "1");
		await save(view);

		view = await reopen(view);
		expect(value(view.getByLabelText("最大ロット数"))).toBe("3");
		expect(value(second())).toBe("1");

		changeValue(second(), "0.05");
		expect(second().getAttribute("aria-invalid")).toBe("true");
		// 行の下に1回だけ出す
		expect(buy().getAllByText("上の行（0.1%）より大きくする")).toHaveLength(1);
		expect(blocked(view)).toBe(true);
	});

	test("買いを足して名前を付けると、買いごとに条件を持って保存でき、並べ替え・削除できる", async () => {
		let view = await open(strategiesApi());
		await createFromTemplate(view, "複数の買い", /^トレンド追随/);

		fireEvent.click(view.getByRole("button", { name: "＋ 買いを追加" }));
		changeValue(
			region(view, "買い「買い2」").getByLabelText("買いの名前"),
			"押し目",
		);
		const dip = () => region(view, "買い「押し目」");
		changeValue(dip().getByLabelText("最大ロット数"), "3");
		// 足したばかりの買いは買いの条件が無く、保存できない
		expect(blocked(view)).toBe(true);
		addCondition(view, "「押し目」の買い注文する条件", /^RSI$/);
		await save(view);

		view = await reopen(view);
		expect(value(dip().getByLabelText("最大ロット数"))).toBe("3");
		expect(
			value(region(view, "買い「買い1」").getByLabelText("最大ロット数")),
		).not.toBe("3");

		// 閉じると要約だけになる
		fireEvent.click(dip().getByRole("button", { expanded: true }));
		expect(dip().queryAllByLabelText("買いの名前")).toHaveLength(0);

		fireEvent.click(view.getByRole("button", { name: "「押し目」を上へ" }));
		expect(
			view
				.getAllByRole("region", { name: /^買い「/ })[0]
				?.getAttribute("aria-label"),
		).toBe("買い「押し目」");
		fireEvent.click(view.getByRole("button", { name: "「押し目」を削除" }));
		expect(view.getAllByRole("region", { name: /^買い「/ })).toHaveLength(1);
		expect(
			view.queryAllByRole("button", { name: "「買い1」を上へ" }),
		).toHaveLength(0);
	});
});

describe("戦略の作成", () => {
	test("ひな形から作ると編集画面が開き、同じ名前を付けようとするとサーバーの理由を出す", async () => {
		const view = await open(strategiesApi());
		const base = "レンジ";
		await createFromTemplate(view, base, /^レンジ逆張り/);
		expect(view.location.current).toBe("/strategies/1/edit");

		cleanup();
		const list = await open(view.api);
		expect(
			list.getByRole("list", { name: "戦略の一覧" }).textContent,
		).toContain(base);
		fireEvent.click(list.getByRole("button", { name: "＋ 新しい戦略" }));
		const dialog = within(list.getByRole("dialog", { name: "新しい戦略" }));
		changeValue(dialog.getByLabelText("名前"), base);
		fireEvent.click(dialog.getByRole("button", { name: /^空の戦略/ }));
		expect(
			await dialog.findByText("同じ名前の戦略がある。別の名前にする", {}, wait),
		).toBeTruthy();
	});
});
