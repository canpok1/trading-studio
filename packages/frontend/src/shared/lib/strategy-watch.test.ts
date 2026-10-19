import { describe, expect, test } from "bun:test";
import type {
	StrategyWatch,
	WatchAction,
	WatchCondition,
	WatchWait,
} from "@trading-studio/core";
import {
	chartTriggers,
	distanceText,
	moveText,
	pendingOrderWaits,
	waitLines,
	waitText,
} from "./strategy-watch";

const act = (
	kind: WatchAction["kind"],
	price: number | null,
	lotId: string | null = null,
): WatchAction => ({ kind, price, buyId: "b1", buyName: "買い1", lotId });

const watch = (actions: WatchAction[]): StrategyWatch => ({
	price: 1_000,
	buys: [],
	actions,
	waits: [],
});

describe("chartTriggers", () => {
	test("価格のあるものだけ、同じ価格・種類は1本にし、一番近い上下に印を付ける", () => {
		expect(
			chartTriggers(
				watch([
					act("stopLoss", 900, "o1"),
					act("stopLoss", 900, "o2"),
					act("stopLoss", 800, "o3"),
					act("takeProfit", 1_200, "o1"),
					act("stopLoss", null, "o4"),
				]),
			),
		).toEqual([
			{ price: 900, kind: "stopLoss" },
			{ price: 800, kind: "stopLoss" },
			{ price: 1_200, kind: "takeProfit" },
		]);
		expect(chartTriggers(null)).toEqual([]);
	});
});

test("distanceText は今の価格からの % を符号付き小数2桁で返す", () => {
	expect(distanceText(1_008.8, 1_000)).toBe("+0.88%");
	expect(distanceText(956.1, 1_000)).toBe("−4.39%");
});

test("moveText は今の価格からの幅を符号付きの % と円の差で返す", () => {
	expect(moveText(13_113_254, 13_000_000)).toEqual({
		percent: "+0.87%",
		yen: "+113,254 円",
	});
	expect(moveText(12_429_300, 13_000_000)).toEqual({
		percent: "−4.39%",
		yen: "−570,700 円",
	});
});

describe("waitText", () => {
	const wait = (
		reason: WatchWait["reason"],
		over: Partial<WatchWait> = {},
	): WatchWait => ({
		kind: "entry",
		buyId: "b1",
		buyName: "買い1",
		lotId: null,
		reason,
		...over,
	});
	const sentiment: WatchCondition = {
		condition: { type: "judgment", judge: "sentiment", values: ["+1"] },
		met: false,
		detail: "今 中立",
		edge: null,
	};
	const rsi: WatchCondition = {
		condition: {
			type: "rsi",
			timeframe: "1h",
			period: 14,
			threshold: 30,
			direction: "below",
		},
		met: false,
		detail: "今 46.2",
		edge: null,
	};
	const cond = (conditions: WatchCondition[], at: number | "now" | null) =>
		wait({ kind: "conditions", conditions, at });

	test("価格と関係ない条件は、揃えば届く幅・次の判定・待つ のどれかで書く", () => {
		expect(waitText(cond([sentiment], 988), 1_000)).toBe(
			"センチメント やや強気（今 中立）が揃えば −1.20%で",
		);
		expect(waitText(cond([sentiment], "now"), 1_000)).toBe(
			"センチメント やや強気（今 中立）が揃えば次の判定で",
		);
		expect(waitText(cond([sentiment], null), 1_000)).toBe(
			"センチメント やや強気（今 中立）を待つ",
		);
	});

	test("価格で決まる条件は発動価格を求められないと書き、価格と関係ない条件と混ざれば分けて書く", () => {
		expect(waitText(cond([rsi], null), 1_000)).toBe(
			"発動価格を求められない（1時間足 RSI14 30以下（今 46.2））",
		);
		expect(waitText(cond([sentiment, rsi], null), 1_000)).toBe(
			"センチメント やや強気（今 中立）を待つ・発動価格を求められない（1時間足 RSI14 30以下（今 46.2））",
		);
		expect(waitText(cond([], null), 1_000)).toBe(
			"価格では届かない（条件の成立する価格が重ならない）",
		);
	});

	test("買いが止まっている・売り注文の約定待ち・判定できない", () => {
		expect(
			waitText(
				wait({
					kind: "buyStatus",
					status: { kind: "cooldown", barsLeft: 3, timeframe: "1h" },
				}),
				1_000,
			),
		).toBe("損切り後の待ち（1時間足であと 3 本）");
		expect(waitText(wait({ kind: "selling" }, { kind: "sell" }), 1_000)).toBe(
			"売り注文の約定待ち",
		);
		expect(
			waitText(wait({ kind: "insufficient", reason: "足が足りない" }), 1_000),
		).toBe("判定できない（足が足りない）");
	});

	test("pendingOrderWaits は約定待ちの注文だけを返す（オフでも約定するため）", () => {
		const selling = wait({ kind: "selling" }, { kind: "sell" });
		const fill = wait({ kind: "buyStatus", status: { kind: "waitingFill" } });
		const full = wait({ kind: "buyStatus", status: { kind: "full" } });
		expect(
			pendingOrderWaits([selling, fill, full, cond([sentiment], null)]),
		).toEqual([selling, fill]);
	});

	test("waitLines は同じ買い・種類・理由のロットを1行にまとめる", () => {
		const a = cond([sentiment], null);
		const lines = waitLines(
			[
				{ ...a, kind: "takeProfit", lotId: "o1" },
				{ ...a, kind: "takeProfit", lotId: "o2" },
				{ ...a, kind: "stopLoss", lotId: "o1" },
			],
			1_000,
		);
		expect(lines.map((l) => l.kind)).toEqual(["takeProfit", "stopLoss"]);
	});
});
