import { describe, expect, test } from "bun:test";
import {
	buyHoldPercentOf,
	gradeMaxDrawdown,
	gradePnl,
	gradeProfitFactor,
	gradeTrades,
	gradeWinRate,
} from "./grade";

const label = (v: { label: string } | null) => v?.label ?? null;

describe("成績の評価", () => {
	test("損益はガチホと比べる", () => {
		expect(label(gradePnl(12, 6))).toBe("優秀");
		expect(label(gradePnl(10, 6))).toBe("良い");
		expect(label(gradePnl(6, 6))).toBe("良い");
		expect(label(gradePnl(3, 6))).toBe("普通");
		// 下げ相場で損を抑えた
		expect(label(gradePnl(-2, -8))).toBe("悪い");
		expect(label(gradePnl(0, 3))).toBe("非常に悪い");
		expect(label(gradePnl(-5, 3))).toBe("非常に悪い");
		expect(gradePnl(5, null)).toBeNull();
		expect(gradePnl(null, 5)).toBeNull();
	});

	test("PF は境目を上の段に含める。損失が無ければ優秀、取引が無ければ出さない", () => {
		expect(label(gradeProfitFactor(2, 5))).toBe("優秀");
		expect(label(gradeProfitFactor(null, 5))).toBe("優秀");
		expect(label(gradeProfitFactor(1.5, 5))).toBe("良い");
		expect(label(gradeProfitFactor(1.2, 5))).toBe("普通");
		expect(label(gradeProfitFactor(1, 5))).toBe("悪い");
		expect(label(gradeProfitFactor(0.99, 5))).toBe("非常に悪い");
		expect(gradeProfitFactor(null, 0)).toBeNull();
	});

	test("最大DD は境目を良い側に含める", () => {
		expect(label(gradeMaxDrawdown(5))).toBe("優秀");
		expect(label(gradeMaxDrawdown(10))).toBe("良い");
		expect(label(gradeMaxDrawdown(20))).toBe("普通");
		expect(label(gradeMaxDrawdown(30))).toBe("悪い");
		expect(label(gradeMaxDrawdown(30.1))).toBe("非常に悪い");
	});

	test("勝率", () => {
		expect(label(gradeWinRate(70))).toBe("優秀");
		expect(label(gradeWinRate(60))).toBe("良い");
		expect(label(gradeWinRate(40))).toBe("普通");
		expect(label(gradeWinRate(30))).toBe("悪い");
		expect(label(gradeWinRate(29.9))).toBe("非常に悪い");
		expect(gradeWinRate(null)).toBeNull();
	});

	test("取引回数は3段階", () => {
		expect(label(gradeTrades(30))).toBe("十分");
		expect(label(gradeTrades(10))).toBe("やや少ない");
		expect(label(gradeTrades(9))).toBe("少なすぎ");
	});

	test("ガチホの損益率は最初の足の始値から最後の足の終値。始値が無い足は終値を使う", () => {
		expect(
			buyHoldPercentOf([
				{ open: 100, close: 105 },
				{ open: 105, close: 110 },
			]),
		).toBeCloseTo(10);
		expect(buyHoldPercentOf([{ close: 200 }, { close: 150 }])).toBeCloseTo(-25);
		expect(buyHoldPercentOf([])).toBeNull();
	});
});
