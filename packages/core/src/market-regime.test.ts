import { describe, expect, test } from "bun:test";
import {
	classifyMarket,
	judgmentRecordStart,
	rangesOutside,
	segmentPeriods,
} from "./market-regime";

/** 終値が毎日 r ずつ（対数で）動く日足 */
const steady = (days: number, r: number, start = 10_000_000) =>
	Array.from({ length: days }, (_, i) => {
		const open = Math.round(start * Math.exp(r * i));
		return { open, close: Math.round(start * Math.exp(r * (i + 1))) };
	});

describe("classifyMarket", () => {
	test("騰落率が +12% 以上なら上昇、−12% 以下なら下落、その間はレンジ", () => {
		expect(classifyMarket(steady(60, 0.003))?.regime).toBe("up");
		expect(classifyMarket(steady(60, -0.003))?.regime).toBe("down");
		expect(classifyMarket(steady(60, 0.001))?.regime).toBe("range");
	});

	test("境目の騰落率はちょうどでも上昇・下落に入れる", () => {
		const bars = [
			{ open: 1_000_000, close: 1_000_000 },
			{ open: 1_000_000, close: 1_120_000 },
		];
		expect(classifyMarket(bars)).toEqual({
			regime: "up",
			returnPpm: 120_000,
			volatilityPpm: 0,
		});
	});

	test("日ごとの値動きの標準偏差が 3.5% 以上なら、騰落率によらず乱高下", () => {
		// 交互に ±4% 動く。期間の騰落率はほぼ 0
		const bars = Array.from({ length: 60 }, (_, i) => {
			const up = i % 2 === 0;
			return up
				? { open: 10_000_000, close: 10_400_000 }
				: { open: 10_400_000, close: 10_000_000 };
		});
		const r = classifyMarket(bars);
		expect(r?.regime).toBe("volatile");
		expect(r?.volatilityPpm).toBeGreaterThanOrEqual(35_000);
	});

	test("足が2本未満なら判定しない", () => {
		expect(classifyMarket([])).toBeNull();
		expect(classifyMarket([{ open: 1, close: 1 }])).toBeNull();
	});
});

describe("segmentPeriods", () => {
	const jst = (s: string) => Date.parse(`${s}+09:00`);

	test("最初の足を含む月から、今月の初めまでに終わる2か月を1か月ずつずらす", () => {
		expect(
			segmentPeriods(jst("2026-07-15T12:00:00"), jst("2026-10-01T04:00:00")),
		).toEqual([
			{ from: jst("2026-07-01T00:00:00"), to: jst("2026-09-01T00:00:00") },
			{ from: jst("2026-08-01T00:00:00"), to: jst("2026-10-01T00:00:00") },
		]);
	});

	test("年をまたぐ", () => {
		expect(
			segmentPeriods(jst("2025-12-01T00:00:00"), jst("2026-02-10T00:00:00")),
		).toEqual([
			{ from: jst("2025-12-01T00:00:00"), to: jst("2026-02-01T00:00:00") },
		]);
	});

	test("まだ2か月たっていなければ無い", () => {
		expect(
			segmentPeriods(jst("2026-09-01T00:00:00"), jst("2026-10-31T23:59:00")),
		).toEqual([]);
	});
});

describe("judgmentRecordStart", () => {
	const D = 86_400_000;
	test("ニュースを消していなければ最初の採点から", () => {
		expect(judgmentRecordStart(100 * D, null)).toBe(100 * D);
		expect(judgmentRecordStart(null, 50 * D)).toBeNull();
	});
	test("消した後は境目の31日後から。それより後に採点が始まっていればその時点から", () => {
		expect(judgmentRecordStart(100 * D, 300 * D)).toBe(331 * D);
		expect(judgmentRecordStart(400 * D, 300 * D)).toBe(400 * D);
	});
	test("残した相場データは開始から", () => {
		expect(judgmentRecordStart(100 * D, 300 * D, 200 * D)).toBe(200 * D);
		// 境目の31日後より後に始まる相場データは特別扱いしない
		expect(judgmentRecordStart(100 * D, 300 * D, 350 * D)).toBe(331 * D);
	});
});

describe("rangesOutside", () => {
	const MIN = Number.MIN_SAFE_INTEGER;
	test("残す範囲を除き、重なる範囲はまとめて扱う", () => {
		expect(
			rangesOutside(100, [
				{ from: 50, to: 60 },
				{ from: 10, to: 20 },
				{ from: 15, to: 30 },
			]),
		).toEqual([
			{ from: MIN, to: 10 },
			{ from: 30, to: 50 },
			{ from: 60, to: 100 },
		]);
	});
	test("境目をまたぐ・越える範囲", () => {
		expect(rangesOutside(100, [{ from: 90, to: 120 }])).toEqual([
			{ from: MIN, to: 90 },
		]);
		expect(rangesOutside(100, [{ from: 150, to: 200 }])).toEqual([
			{ from: MIN, to: 100 },
		]);
		expect(rangesOutside(100, [])).toEqual([{ from: MIN, to: 100 }]);
	});
});
