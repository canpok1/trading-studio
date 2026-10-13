import { describe, expect, test } from "bun:test";
import { strategyTemplate } from "@trading-studio/core";
import { frequencyText, groupText } from "./condition-text";

describe("条件の文字列", () => {
	const p = strategyTemplate("trend").params;

	test("頻度とグループを1行で表す", () => {
		expect(frequencyText(p)).toBe("判定 なし1時間/あり15分ごと");
		expect(
			groupText(p.buys[0]?.takeProfit ?? { match: "all", conditions: [] }),
		).toBe("+4% または 1時間足 EMA12/48下抜け");
		expect(groupText({ match: "all", conditions: [] })).toBe("なし");
	});
});
