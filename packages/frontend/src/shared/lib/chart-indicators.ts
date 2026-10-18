// チャートに重ねる EMA・RSI・ボリンジャーバンドの本数と DVOL の平均。既定は戦略の条件の値で、画面で変えた値はブラウザに保存し、
// ホームとバックテスト結果で共有する

import type { Condition, ConditionSet } from "@trading-studio/core";
import {
	CONDITION_GROUPS,
	emaPeriods,
	LIMITS,
	rsiLines,
} from "@trading-studio/core";
import { useCallback, useEffect, useMemo, useState } from "react";

/** EMA の本数（1〜2本、小さい順） */
export type EmaSetting = number[];
/** RSI の本数と、点線を引く下・上のしきい値 */
export type RsiSetting = { period: number; lower: number; upper: number };

/** ボリンジャーバンドの本数と σ */
export type BbSetting = { period: number; sigma: number };

/** DVOL の平均の日数と、点線を引く平均に対する下・上の % */
export type DvolAvgSetting = { days: number; lower: number; upper: number };

/** 戦略で使っていないときの値 */
export const DEFAULT_EMA: EmaSetting = [20, 50];
export const DEFAULT_RSI: RsiSetting = { period: 14, lower: 30, upper: 70 };
export const DEFAULT_BB: BbSetting = { period: 20, sigma: 2 };
/** 条件を追加するときの既定（買い 120% 以下・売り 150% 以上）に合わせる */
export const DEFAULT_DVOL_AVG: DvolAvgSetting = {
	days: 30,
	lower: 120,
	upper: 150,
};

/** EMA の線は2色なので2本まで */
export const MAX_EMA_LINES = 2;

const STORAGE_KEY = "chart-indicators";

const isIntIn = (n: unknown, r: { min: number; max: number }) =>
	typeof n === "number" && Number.isInteger(n) && n >= r.min && n <= r.max;

export function validEma(v: unknown): v is EmaSetting {
	return (
		Array.isArray(v) &&
		v.length >= 1 &&
		v.length <= MAX_EMA_LINES &&
		v.every((n) => isIntIn(n, LIMITS.emaPeriod)) &&
		new Set(v).size === v.length
	);
}

export function validRsi(v: unknown): v is RsiSetting {
	if (typeof v !== "object" || v === null) return false;
	const r = v as Record<string, unknown>;
	return (
		isIntIn(r.period, LIMITS.rsiPeriod) &&
		isIntIn(r.lower, LIMITS.rsiThreshold) &&
		isIntIn(r.upper, LIMITS.rsiThreshold) &&
		(r.lower as number) < (r.upper as number)
	);
}

export function validBb(v: unknown): v is BbSetting {
	if (typeof v !== "object" || v === null) return false;
	const r = v as Record<string, unknown>;
	const s = LIMITS.bollingerSigma;
	return (
		isIntIn(r.period, LIMITS.bollingerPeriod) &&
		typeof r.sigma === "number" &&
		r.sigma >= s.min &&
		r.sigma <= s.max &&
		Math.abs(r.sigma * 10 - Math.round(r.sigma * 10)) < 1e-9
	);
}

export function validDvolAvg(v: unknown): v is DvolAvgSetting {
	if (typeof v !== "object" || v === null) return false;
	const r = v as Record<string, unknown>;
	return (
		isIntIn(r.days, LIMITS.dvolDays) &&
		isIntIn(r.lower, LIMITS.dvolPercent) &&
		isIntIn(r.upper, LIMITS.dvolPercent) &&
		(r.lower as number) < (r.upper as number)
	);
}

/** 戦略の条件をすべて（買いごと・グループごと） */
const allConditions = (params: ConditionSet | null): Condition[] =>
	params
		? params.buys.flatMap((b) =>
				CONDITION_GROUPS.flatMap((k) => b[k].conditions),
			)
		: [];

/** 戦略で DVOL の条件（値・平均との比）を使っているか */
export const usesDvol = (params: ConditionSet | null) =>
	allConditions(params).some(
		(c) => c.type === "dvol" || c.type === "dvolAverage",
	);

/**
 * 戦略の DVOL の平均。使っていなければ null。日数が複数あれば短い方を使い、その日数の条件の % の最小・最大を下・上にする。
 * % が1つだけなら、既定の上（150）より下なら下側、それ以外は上側に置き、もう片方は既定の値にする
 */
export function strategyDvolAvg(
	params: ConditionSet | null,
): DvolAvgSetting | null {
	const cs = allConditions(params).flatMap((c) =>
		c.type === "dvolAverage" ? [c] : [],
	);
	if (cs.length === 0) return null;
	const days = Math.min(...cs.map((c) => c.days));
	const ps = cs.filter((c) => c.days === days).map((c) => c.percent);
	const lo = Math.min(...ps);
	const hi = Math.max(...ps);
	if (lo !== hi) return { days, lower: lo, upper: hi };
	const d = DEFAULT_DVOL_AVG;
	return lo < d.upper
		? { days, lower: lo, upper: d.upper }
		: { days, lower: d.lower, upper: lo };
}

/** 戦略の DVOL の値の条件のしきい値（年率 %、小さい順・重複なし） */
export function strategyDvolLevels(params: ConditionSet | null): number[] {
	const ts = allConditions(params).flatMap((c) =>
		c.type === "dvol" ? [c.threshold] : [],
	);
	return [...new Set(ts)].sort((a, b) => a - b);
}

/** 戦略の EMA の本数。使っていなければ null。3本以上あれば短い方から2本 */
export function strategyEma(params: ConditionSet | null): EmaSetting | null {
	const ps = params ? emaPeriods(params) : [];
	return ps.length > 0 ? ps.slice(0, MAX_EMA_LINES) : null;
}

/**
 * 戦略の RSI。使っていなければ null。本数が複数あれば短い方を使う。
 * しきい値が1つだけなら、50 より下なら下側、それ以外は上側に置き、もう片方は既定の値にする
 */
export function strategyRsi(params: ConditionSet | null): RsiSetting | null {
	const first = params ? rsiLines(params)[0] : undefined;
	if (!first) return null;
	const ts = first.thresholds;
	const lo = ts[0] as number;
	const hi = ts.at(-1) as number;
	if (lo !== hi) return { period: first.period, lower: lo, upper: hi };
	return lo < 50
		? { period: first.period, lower: lo, upper: DEFAULT_RSI.upper }
		: { period: first.period, lower: DEFAULT_RSI.lower, upper: lo };
}

/** 戦略のボリンジャーバンド。使っていなければ null。複数あれば本数が短い方（同じ本数なら σ が小さい方） */
export function strategyBb(params: ConditionSet | null): BbSetting | null {
	const all = allConditions(params).flatMap((c) =>
		c.type === "bollinger" ? [{ period: c.period, sigma: c.sigma }] : [],
	);
	all.sort((a, b) => a.period - b.period || a.sigma - b.sigma);
	return all[0] ?? null;
}

type Saved = {
	ema?: EmaSetting;
	rsi?: RsiSetting;
	bb?: BbSetting;
	dvolAvg?: DvolAvgSetting;
};

/** 保存した値。壊れている項目は捨てる */
export function parseSaved(raw: string | null): Saved {
	try {
		const v = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
		return {
			ema: validEma(v.ema) ? v.ema : undefined,
			rsi: validRsi(v.rsi) ? v.rsi : undefined,
			bb: validBb(v.bb) ? v.bb : undefined,
			dvolAvg: validDvolAvg(v.dvolAvg) ? v.dvolAvg : undefined,
		};
	} catch {
		return {};
	}
}

function readSaved(): Saved {
	try {
		return parseSaved(localStorage.getItem(STORAGE_KEY));
	} catch {
		return {};
	}
}

function writeSaved(s: Saved) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
	} catch {
		// 保存できなくても、この画面の間は変えた値で描く
	}
}

/** base と同じ値は保存しない（戦略の値が変わったら追従させるため）。null も保存しない */
function sameValue<T>(v: T | null, base: T): boolean {
	return v === null || JSON.stringify(v) === JSON.stringify(base);
}

/** 1つの指標の、表示の状態と操作 */
export type IndicatorControl<T> = {
	/** 描く値（保存した値、なければ戦略の値、なければ既定） */
	value: T;
	/** 「戻す」で戻る値（戦略の値、なければ既定） */
	base: T;
	/** base が戦略の値か（false なら既定） */
	fromStrategy: boolean;
	/** 画面で変えた値を保存しているか */
	custom: boolean;
	on: boolean;
	setOn: (on: boolean) => void;
	/** 値を保存して表示する。null で保存を消して base へ戻す */
	save: (v: T | null) => void;
};

export type ChartIndicators = {
	ema: IndicatorControl<EmaSetting>;
	rsi: IndicatorControl<RsiSetting>;
	bb: IndicatorControl<BbSetting>;
	/** DVOL の平均の線と、平均に対する % の点線。描くのは DVOL の小窓を出しているときだけ */
	dvolAvg: IndicatorControl<DvolAvgSetting>;
	/** 戦略で DVOL の条件を使っているか（使っていれば DVOL の小窓を最初から出す） */
	dvolUsed: boolean;
	/** 戦略の DVOL の値の条件のしきい値。小窓に点線を引く */
	dvolLevels: number[];
};

/**
 * チャートの EMA・RSI・ボリンジャーバンド・DVOL の平均の設定。最初は、戦略で使っているか値を保存していれば表示し、そうでなければ隠す。
 * 戦略が変わったら表示の有無を最初の状態へ戻す
 */
export function useChartIndicators(
	params: ConditionSet | null,
): ChartIndicators {
	const [saved, setSaved] = useState<Saved>(readSaved);
	const sEma = useMemo(() => strategyEma(params), [params]);
	const sRsi = useMemo(() => strategyRsi(params), [params]);
	const sBb = useMemo(() => strategyBb(params), [params]);
	const sDvolAvg = useMemo(() => strategyDvolAvg(params), [params]);
	const dvolUsed = useMemo(() => usesDvol(params), [params]);
	const levelsKey = JSON.stringify(strategyDvolLevels(params));
	// 中身が同じなら同じ配列を返し、チャートを描き直さない
	const dvolLevels = useMemo(
		() => JSON.parse(levelsKey) as number[],
		[levelsKey],
	);
	const strategyKey = JSON.stringify([sEma, sRsi, sBb, sDvolAvg]);
	// null は「最初の状態」（戦略で使っているか、値を保存していれば表示）
	const [emaOn, setEmaOn] = useState<boolean | null>(null);
	const [rsiOn, setRsiOn] = useState<boolean | null>(null);
	const [bbOn, setBbOn] = useState<boolean | null>(null);
	const [dvolAvgOn, setDvolAvgOn] = useState<boolean | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 戦略の値が変わったときだけ戻す
	useEffect(() => {
		setEmaOn(null);
		setRsiOn(null);
		setBbOn(null);
		setDvolAvgOn(null);
	}, [strategyKey]);

	const update = useCallback((patch: Saved) => {
		setSaved((cur) => {
			const next = { ...cur, ...patch };
			writeSaved(next);
			return next;
		});
	}, []);

	const emaBase = sEma ?? DEFAULT_EMA;
	const rsiBase = sRsi ?? DEFAULT_RSI;
	const bbBase = sBb ?? DEFAULT_BB;
	const dvolAvgBase = sDvolAvg ?? DEFAULT_DVOL_AVG;
	return {
		ema: {
			value: saved.ema ?? emaBase,
			base: emaBase,
			fromStrategy: sEma !== null,
			custom: saved.ema !== undefined,
			on: emaOn ?? (sEma !== null || saved.ema !== undefined),
			setOn: setEmaOn,
			save: (v) => {
				const sorted = v && [...v].sort((a, b) => a - b);
				update({
					ema: sameValue(sorted, emaBase) ? undefined : (sorted ?? undefined),
				});
				setEmaOn(true);
			},
		},
		rsi: {
			value: saved.rsi ?? rsiBase,
			base: rsiBase,
			fromStrategy: sRsi !== null,
			custom: saved.rsi !== undefined,
			on: rsiOn ?? (sRsi !== null || saved.rsi !== undefined),
			setOn: setRsiOn,
			save: (v) => {
				update({ rsi: sameValue(v, rsiBase) ? undefined : (v ?? undefined) });
				setRsiOn(true);
			},
		},
		bb: {
			value: saved.bb ?? bbBase,
			base: bbBase,
			fromStrategy: sBb !== null,
			custom: saved.bb !== undefined,
			on: bbOn ?? (sBb !== null || saved.bb !== undefined),
			setOn: setBbOn,
			save: (v) => {
				update({ bb: sameValue(v, bbBase) ? undefined : (v ?? undefined) });
				setBbOn(true);
			},
		},
		dvolAvg: {
			value: saved.dvolAvg ?? dvolAvgBase,
			base: dvolAvgBase,
			fromStrategy: sDvolAvg !== null,
			custom: saved.dvolAvg !== undefined,
			on: dvolAvgOn ?? (sDvolAvg !== null || saved.dvolAvg !== undefined),
			setOn: setDvolAvgOn,
			save: (v) => {
				update({
					dvolAvg: sameValue(v, dvolAvgBase) ? undefined : (v ?? undefined),
				});
				setDvolAvgOn(true);
			},
		},
		dvolUsed,
		dvolLevels,
	};
}
