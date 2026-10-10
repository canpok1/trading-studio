import { describe, expect, test } from "bun:test";
import type { StrategyWatch, WatchAction } from "@trading-studio/core";
import { chartTriggers, distanceText, nextMoves } from "./strategy-watch";

const act = (
	kind: WatchAction["kind"],
	price: number | null,
	lotId: string | null = null,
): WatchAction => ({ kind, price, buyId: "b1", buyName: "買い1", lotId });

const watch = (actions: WatchAction[]): StrategyWatch => ({
	price: 1_000,
	buys: [],
	actions,
});

describe("nextMoves", () => {
	test("上側・下側で一番近い発動価格を1つずつと、次の判定で起きるものを返す", () => {
		const w = watch([
			act("takeProfit", 1_100, "o1"),
			act("entry", 1_050),
			act("stopLoss", 900, "o1"),
			act("partialTakeProfit", 950, "o1"),
			act("stopLoss", null, "o2"),
		]);
		const m = nextMoves(w);
		expect(m.up).toEqual(act("entry", 1_050));
		expect(m.down).toEqual(act("partialTakeProfit", 950, "o1"));
		expect(m.now).toEqual([act("stopLoss", null, "o2")]);
	});

	test("同じ価格なら損切りを先に選ぶ", () => {
		const m = nextMoves(watch([act("entry", 900), act("stopLoss", 900, "o1")]));
		expect(m.down?.kind).toBe("stopLoss");
	});
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
			{ price: 900, kind: "stopLoss", near: true },
			{ price: 800, kind: "stopLoss", near: false },
			{ price: 1_200, kind: "takeProfit", near: true },
		]);
		expect(chartTriggers(null)).toEqual([]);
	});
});

test("distanceText は今の価格からの % を符号付き小数2桁で返す", () => {
	expect(distanceText(1_008.8, 1_000)).toBe("+0.88%");
	expect(distanceText(956.1, 1_000)).toBe("−4.39%");
});
