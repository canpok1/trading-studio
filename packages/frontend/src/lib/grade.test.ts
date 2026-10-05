import { describe, expect, test } from "bun:test";
import {
	buyHoldPercentOf,
	fewTradesNote,
	gradeMaxDrawdown,
	gradePnl,
	gradeProfitFactor,
	gradeRiskPrecision,
	gradeSentimentPrecision,
	gradeWinRate,
} from "./grade";

const label = (v: { label: string } | null) => v?.label ?? null;

describe("成績の評価", () => {
	test("損益はガチホと比べる。0% はプラス側に入れる", () => {
		expect(label(gradePnl(12, 6, false))).toBe("優秀");
		expect(label(gradePnl(10, 6, false))).toBe("良い");
		expect(label(gradePnl(6, 6, false))).toBe("良い");
		expect(label(gradePnl(3, 6, false))).toBe("普通");
		expect(label(gradePnl(0, 3, false))).toBe("普通");
		expect(label(gradePnl(0, -2, false))).toBe("良い");
		// 下げ相場で損を抑えた
		expect(label(gradePnl(-2, -8, false))).toBe("悪い");
		expect(label(gradePnl(-5, 3, false))).toBe("非常に悪い");
		expect(gradePnl(5, null, false)).toBeNull();
		expect(gradePnl(null, 5, false)).toBeNull();
	});

	test("取引も保有も無ければ、相場に関わらず損益は普通", () => {
		expect(label(gradePnl(0, -10, true))).toBe("普通");
		expect(label(gradePnl(0, 10, true))).toBe("普通");
		expect(gradePnl(0, null, true)).toBeNull();
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

	test("取引が1〜29回のときだけ、勝率・PF が偶然の可能性があると知らせる", () => {
		expect(fewTradesNote(12)).toBe(
			"取引が12回しかないため、勝率・PF の評価は偶然の可能性があります",
		);
		expect(fewTradesNote(29)).not.toBeNull();
		expect(fewTradesNote(30)).toBeNull();
		// 取引が無ければ勝率・PF の評価も出ない
		expect(fewTradesNote(0)).toBeNull();
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

describe("市場評価の精度", () => {
	test("センチメントは的中率を 50% の前後で分ける", () => {
		expect(label(gradeSentimentPrecision(65, 30))).toBe("優秀");
		expect(label(gradeSentimentPrecision(55, 30))).toBe("良い");
		expect(label(gradeSentimentPrecision(50, 30))).toBe("普通");
		expect(label(gradeSentimentPrecision(44.9, 30))).toBe("悪い");
		expect(label(gradeSentimentPrecision(34, 30))).toBe("非常に悪い");
	});
	test("リスクは見分け率をセンチメントと同じ基準で分ける", () => {
		expect(label(gradeRiskPrecision(65, 30))).toBe("優秀");
		expect(label(gradeRiskPrecision(51, 30))).toBe("普通");
		expect(label(gradeRiskPrecision(34, 30))).toBe("非常に悪い");
	});
	test("30件未満か値が無ければデータ不足", () => {
		expect(label(gradeSentimentPrecision(80, 29))).toBe("データ不足");
		expect(label(gradeRiskPrecision(null, 100))).toBe("データ不足");
	});
});
