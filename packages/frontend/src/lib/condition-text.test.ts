import { describe, expect, test } from "bun:test";
import { strategyTemplate } from "@trading-studio/core";
import { conditionDiff, frequencyText, groupText } from "./condition-text";

describe("条件の文字列", () => {
	const p = strategyTemplate("trend").params;

	test("頻度とグループを1行で表す", () => {
		expect(frequencyText(p)).toBe("判定 なし1時間/あり15分ごと");
		expect(groupText(p.takeProfit)).toBe("+4% または EMA12/48下抜け");
		expect(groupText({ match: "all", conditions: [] })).toBe("なし");
	});

	test("差分は変わった項目だけ", () => {
		expect(conditionDiff(p, p)).toEqual([]);
		const q = { ...p, orderSize: 3_000_000 };
		expect(conditionDiff(p, q)).toEqual([
			["1回の注文量", "0.020 BTC", "0.030 BTC"],
		]);
	});
});
