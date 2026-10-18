import { describe, expect, test } from "bun:test";
import type { ConditionSet } from "@trading-studio/core";
import { strategyTemplate } from "@trading-studio/core";
import { strategyDvol } from "./dvol-domain";
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
