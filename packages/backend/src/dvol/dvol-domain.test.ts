import { describe, expect, test } from "bun:test";
import type { ConditionSet } from "@trading-studio/core";
import { strategyTemplate } from "@trading-studio/core";
import { parseDvolBarsQuery, strategyDvol, withAverage } from "./dvol-domain";
import type { DvolFetchState } from "./repository-domain";
import type { DvolBar } from "./types-domain";

const H = 3_600_000;
const bars: DvolBar[] = [0, 1, 2, 3, 4].map((i) => ({
	time: i * H,
	open: 5000,
	high: 5000,
	low: 5000,
	close: 5000 + i,
}));
const repo = (lastSuccessAt: number | null) => ({
	bars: (from: number, to: number) =>
		bars.filter((b) => b.time >= from && b.time < to),
	fetchState: (): DvolFetchState => ({
		lastSuccessAt,
		lastError: null,
		errorSince: null,
	}),
});
const base = strategyTemplate("trend").params;
const withDvol: ConditionSet = {
	...base,
	buys: base.buys.map((b) => ({
		...b,
		buy: {
			match: "all",
			conditions: [{ type: "dvol", threshold: 60, direction: "below" }],
		},
	})),
};

describe("strategyDvol", () => {
	test("最後に取得した時点で終わっていた足だけを返す（終わる前に取った足は途中の値のため）", () => {
		// 3:30 に取得した。開始 3:00 の足は取得の時点で終わっていない
		const out = strategyDvol(repo(3 * H + H / 2), withDvol, 5 * H, 5 * H);
		expect(out.map((b) => b.time)).toEqual([1 * H, 2 * H]);
		expect(out[0]).toEqual({ time: H, close: 5001 });
	});

	test("取得したことが無い・DVOL の条件が無ければ空", () => {
		expect(strategyDvol(repo(null), withDvol, 5 * H, 5 * H)).toEqual([]);
		expect(strategyDvol(repo(10 * H), base, 5 * H, 5 * H)).toEqual([]);
	});
});

describe("parseDvolBarsQuery", () => {
	test("平均の日数は 1〜30 の整数だけ受け付ける", () => {
		expect(
			parseDvolBarsQuery({ from: "0", to: "1", averageDays: "30" }),
		).toEqual({ from: 0, to: 1, averageDays: 30 });
		expect(parseDvolBarsQuery({ from: "0", to: "1" })).toEqual({
			from: 0,
			to: 1,
		});
		for (const d of ["0", "31", "1.5", "x"]) {
			expect(
				parseDvolBarsQuery({ from: "0", to: "1", averageDays: d }),
			).toBeNull();
		}
	});
});

describe("withAverage", () => {
	// 2日ぶん。終値は 1日目が 4000、2日目が 6000
	const points: DvolBar[] = Array.from({ length: 48 }, (_, i) => ({
		time: i * H,
		open: 0,
		high: 0,
		low: 0,
		close: i < 24 ? 4000 : 6000,
	}));
	test("足が終わった時点の直近 N 日の平均を付け、足りなければ null", () => {
		const out = withAverage(points.slice(22), points, 1);
		// 開始 22:00 の足の時点では 23 本しかない（1日 24 本の 9 割 = 22 本は満たす）
		expect(out[0]?.average).toBe(4000);
		// 開始 23:00 の足が終わった時点で 1日目の 24 本がそろう
		expect(out[1]?.average).toBe(4000);
		// 2日目の最後の足が終わった時点では 2日目の 24 本だけ
		expect(out.at(-1)?.average).toBe(6000);
		expect(withAverage(points.slice(0, 1), points, 1)[0]?.average).toBeNull();
	});
});
