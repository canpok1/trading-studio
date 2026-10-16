import { describe, expect, test } from "bun:test";
import { strategyTemplate } from "@trading-studio/core";
import { conditionText, frequencyText, groupText } from "./condition-text";

describe("条件の文字列", () => {
	const p = strategyTemplate("trend").params;

	test("頻度とグループを1行で表す", () => {
		expect(frequencyText(p)).toBe("判定 なし1時間/あり15分ごと");
		expect(
			groupText(p.buys[0]?.takeProfit ?? { match: "all", conditions: [] }),
		).toBe("+4% または 1時間足 EMA12/48下抜け");
		expect(groupText({ match: "all", conditions: [] })).toBe("なし");
	});

	test("ADX は足・本数・しきい値・以上/以下", () => {
		expect(
			conditionText({
				type: "adx",
				timeframe: "4h",
				period: 14,
				threshold: 20,
				direction: "below",
			}),
		).toBe("4時間足 ADX14 20以下");
	});

	test("予定の前後は重要度の下限と前後の時間", () => {
		expect(
			conditionText({
				type: "eventWindow",
				minImportance: "medium",
				beforeHours: 2,
				afterHours: 12,
				allowNoCalendar: false,
			}),
		).toBe("予定（重要度 中以上）の前 2 時間・後 12 時間でない");
		expect(
			conditionText({
				type: "eventWindow",
				minImportance: "high",
				beforeHours: 0,
				afterHours: 24,
				allowNoCalendar: true,
			}),
		).toBe("予定（重要度 高）の後 24 時間でない（暦切れは成立）");
	});
});
