import { describe, expect, test } from "bun:test";
import type { Market } from "@trading-studio/core";
import { COINCHECK } from "@trading-studio/core";
import { conditionMenu } from "./ConditionEditor";

const titles = (menu: ReturnType<typeof conditionMenu>) =>
	menu.map(([title]) => title);

describe("条件を足すときの選択肢", () => {
	test("BTC/JPY の市場では、買いに市場評価・ボラティリティ・予定も出す", () => {
		expect(titles(conditionMenu("buy", COINCHECK))).toEqual([
			"価格・保有",
			"市場評価",
			"ボラティリティ",
			"予定",
		]);
	});

	test("材料の紐づかない市場では、価格・保有だけを出す", () => {
		const other: Market = { ...COINCHECK, id: "other", signals: [] };
		expect(titles(conditionMenu("buy", other))).toEqual(["価格・保有"]);
		expect(titles(conditionMenu("stopLoss", other))).toEqual(["価格・保有"]);
	});

	test("紐づく材料だけの見出しを出す", () => {
		const dvolOnly: Market = { ...COINCHECK, id: "other", signals: ["dvol"] };
		expect(conditionMenu("buy", dvolOnly)).toEqual([
			["価格・保有", conditionMenu("buy", COINCHECK)[0]?.[1] ?? []],
			["ボラティリティ", ["dvol"]],
		]);
	});
});
