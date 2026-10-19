import { describe, expect, test } from "bun:test";
import type { StrategyWatch, WatchAction } from "@trading-studio/core";
import {
	chartTriggers,
	distanceText,
	moveText,
	triggerView,
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
	moves: [],
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

describe("triggerView", () => {
	test("価格・注文は向きの矢印と幅、円の差は添え書き", () => {
		expect(triggerView({ kind: "price", price: 1_100 }, 1_000)).toEqual({
			icon: "↑",
			text: "+10.00%で",
			note: "+100 円",
			ordered: false,
		});
		expect(triggerView({ kind: "order", price: 985 }, 1_000)).toEqual({
			icon: "↓",
			text: "−1.50%で",
			note: "−15 円",
			ordered: true,
		});
		expect(triggerView({ kind: "order", price: null }, 1_000).text).toBe(
			"成行で",
		);
	});

	test("時間・価格以外・あと N 条件", () => {
		expect(
			triggerView({ kind: "bars", bars: 5, timeframe: "1h" }, 1_000).text,
		).toBe("あと 5 本（1時間足）で");
		expect(
			triggerView(
				{ kind: "time", at: Date.parse("2026-10-29T19:00:00Z") },
				1_000,
			).text,
		).toBe("10/30 4:00 から");
		expect(
			triggerView(
				{
					kind: "condition",
					condition: { type: "judgment", judge: "sentiment", values: ["+1"] },
					detail: "今 中立",
				},
				1_000,
			),
		).toEqual({
			icon: "◇",
			text: "センチメント やや強気で",
			note: "今 中立",
			ordered: false,
		});
		expect(triggerView({ kind: "remaining", count: 2 }, 1_000).text).toBe(
			"あと 2 条件で",
		);
	});
});
