// チャートに重ねる AI 判定の変換。描画ライブラリに依存しない部分をここに置き、単体テストする

import type { JudgmentSeries } from "@trading-studio/backend";
import type { Judge, JudgmentValue } from "@trading-studio/core";
import { JUDGES } from "@trading-studio/core";

/** 足ごとの判定。i 番目はチャートの i 番目の足。採点の記録が無い足は null */
export type BarJudgments = { [J in Judge]: (JudgmentValue<J> | null)[] };

/**
 * 判定の並びを、チャートの足の並びに合わせる。並びの範囲外の足は null。
 * どの足にも判定が無ければ null（背景と帯を出さない）
 */
export function alignJudgments(
	series: JudgmentSeries,
	barTimes: readonly number[],
): BarJudgments | null {
	const out = { trend: [], risk: [], sentiment: [] } as BarJudgments;
	let any = false;
	for (const t of barTimes) {
		const i = (t - series.from) / series.step;
		for (const j of JUDGES) {
			const v = Number.isInteger(i) ? series.values[j][i] : undefined;
			(out[j] as unknown[]).push(v ?? null);
			if (v != null) any = true;
		}
	}
	return any ? out : null;
}

/** 同じ判定が続く足の区間。null（記録なし）の足は区間にしない */
export type JudgmentRun<V extends string = string> = {
	from: number;
	to: number;
	value: V;
};

export function judgmentRuns<V extends string>(
	values: readonly (V | null)[],
): JudgmentRun<V>[] {
	const out: JudgmentRun<V>[] = [];
	values.forEach((v, i) => {
		if (v === null) return;
		const last = out.at(-1);
		if (last && last.value === v && last.to === i - 1) last.to = i;
		else out.push({ from: i, to: i, value: v });
	});
	return out;
}

/** 背景以外の判定。帯に上から並べる順 */
export function stripJudges(bg: Judge): Judge[] {
	return JUDGES.filter((j) => j !== bg);
}

export const isJudge = (v: unknown): v is Judge =>
	(JUDGES as readonly unknown[]).includes(v);
