import { expect, test } from "bun:test";
import {
	activeFilterCount,
	customRangeError,
	customRangeLabel,
	EMPTY_FILTER,
	evaluationTime,
	groupByDay,
	newsFilterParams,
	newsQuery,
	parseNewsFilter,
} from "./news-filter";

const H = 3_600_000;
const DAY = 24 * H;
// 2026-09-29 12:00 JST
const NOW = Date.UTC(2026, 8, 29, 3);
// 2026-09-28 0:00 JST
const D28 = Date.UTC(2026, 8, 27, 15);

test("URL との読み書きは往復で変わらず、既定の値は書かない", () => {
	expect(newsFilterParams(EMPTY_FILTER).toString()).toBe("");
	const f = {
		period: "custom" as const,
		fromDate: "2026-09-27",
		toDate: "2026-09-28",
		impacts: ["bull" as const, "risk" as const],
		durations: ["none" as const, "long" as const],
		active: true,
		sort: "impact" as const,
		q: "ETF 承認",
	};
	expect(parseNewsFilter(newsFilterParams(f))).toEqual(f);
	expect(
		parseNewsFilter(
			new URLSearchParams("period=x&sort=x&impact=x,bear&dur=x,long&active=x"),
		),
	).toEqual({ ...EMPTY_FILTER, impacts: ["bear"], durations: ["long"] });
});

test("期間は 24時間・7日が今から遡り、日付の指定は終了日の終わりまで", () => {
	expect(newsQuery({ ...EMPTY_FILTER, period: "24h" }, NOW, 100)).toEqual({
		limit: "100",
		from: String(NOW - DAY),
	});
	expect(newsQuery({ ...EMPTY_FILTER, period: "7d" }, NOW, 100).from).toBe(
		String(NOW - 7 * DAY),
	);
	const custom = {
		...EMPTY_FILTER,
		period: "custom" as const,
		fromDate: "2026-09-27",
		toDate: "2026-09-28",
		impacts: ["bear" as const],
		sort: "impact" as const,
		q: " ETF ",
	};
	expect(newsQuery(custom, NOW, 200)).toEqual({
		limit: "200",
		from: String(D28 - DAY),
		to: String(D28 + DAY),
		impact: "bear",
		sort: "impact",
		q: "ETF",
	});
});

test("持続はそのまま、評価に使用中は市場評価の時点（今か日付の指定の終わり）で問い合わせる", () => {
	const f = {
		...EMPTY_FILTER,
		durations: ["long" as const, "medium" as const],
		active: true,
	};
	expect(newsQuery(f, NOW, 100)).toEqual({
		limit: "100",
		duration: "long,medium",
		active: String(NOW),
	});
	expect(
		newsQuery({ ...f, period: "custom", toDate: "2026-09-27" }, NOW, 100)
			.active,
	).toBe(String(D28));
});

test("市場評価の時点は、日付の指定の終わりが今より前のときだけその終わり", () => {
	const custom = { ...EMPTY_FILTER, period: "custom" as const };
	expect(evaluationTime({ ...custom, toDate: "2026-09-27" }, NOW)).toBe(D28);
	expect(evaluationTime({ ...custom, toDate: "2026-09-29" }, NOW)).toBeNull();
	expect(evaluationTime({ ...custom, fromDate: "2026-09-27" }, NOW)).toBeNull();
	expect(evaluationTime({ ...EMPTY_FILTER, period: "24h" }, NOW)).toBeNull();
});

test("日付の指定の誤りと文言", () => {
	const custom = { ...EMPTY_FILTER, period: "custom" as const };
	expect(customRangeError(custom)).toBe("開始日か終了日を入れる");
	expect(
		customRangeError({
			...custom,
			fromDate: "2026-09-28",
			toDate: "2026-09-27",
		}),
	).toBe("開始日を終了日より前にする");
	expect(customRangeError({ ...custom, fromDate: "2026-09-28" })).toBeNull();
	expect(
		customRangeLabel({
			...custom,
			fromDate: "2026-09-01",
			toDate: "2026-09-03",
		}),
	).toBe("9/1〜9/3");
	expect(
		customRangeLabel({
			...custom,
			fromDate: "2026-09-01",
			toDate: "2026-09-01",
		}),
	).toBe("9/1");
	expect(customRangeLabel({ ...custom, toDate: "2026-09-03" })).toBe("〜9/3");
});

test("絞り込みの数はキーワードを数えない", () => {
	expect(
		activeFilterCount({
			...EMPTY_FILTER,
			period: "7d",
			impacts: ["bull", "bear"],
			durations: ["long"],
			active: true,
			q: "x",
		}),
	).toBe(5);
});

test("日付の区切りは JST の日が変わる位置", () => {
	const items = [D28 + H, D28 - 1, D28 - 2 * H].map((publishedAt) => ({
		publishedAt,
	}));
	expect(groupByDay(items).map((g) => [g.day, g.items.length])).toEqual([
		["2026/09/28", 1],
		["2026/09/27", 2],
	]);
});
