// AI の採点と判定が、その後の値動きと合っていたかを調べる。MCP から Claude Code が採点の基準を調整するのに使う（docs/mcp.md）

import type {
	AggregationRule,
	Candle,
	Judge,
	Scores,
	Timeframe,
} from "@trading-studio/core";
import { JUDGES, TIMEFRAME_MS } from "@trading-studio/core";
import type { JudgmentService } from "../judgments/types";
import type { MarketDataService } from "../market-data/types";
import type { Scorer } from "../news/scorer";
import { CRITERIA_MAX } from "../news/scoring-service";
import type {
	AnalysisNewsRow,
	NewsFilter,
	ScoringAnalysisRepository,
} from "./repository";

const HOUR = 3_600_000;

/** その後の値動きを測る長さ */
export const HORIZONS = {
	"1h": HOUR,
	"4h": 4 * HOUR,
	"24h": 24 * HOUR,
} as const;
export type Horizon = keyof typeof HORIZONS;
const HORIZON_KEYS = Object.keys(HORIZONS) as Horizon[];

/** 騰落率（%）。価格が無ければ null */
export type Returns = Record<Horizon, number | null>;

/** 値動きに使う足の候補。細かい順 */
const PRICE_TIMEFRAMES: Timeframe[] = ["5m", "1h"];

/** 分析する期間の上限。足をメモリに載せるため */
export const MAX_ANALYSIS_DAYS = 92;

/** 点数の帯。集計ルールの既定のしきい値の前後で区切る */
const BANDS: Record<Judge, { label: string; min: number; max: number }[]> = {
	risk: [
		{ label: "0〜19", min: 0, max: 19 },
		{ label: "20〜39", min: 20, max: 39 },
		{ label: "40〜69", min: 40, max: 69 },
		{ label: "70〜100", min: 70, max: 100 },
	],
	sentiment: [
		{ label: "-100〜-50", min: -100, max: -50 },
		{ label: "-49〜-20", min: -49, max: -20 },
		{ label: "-19〜19", min: -19, max: 19 },
		{ label: "20〜49", min: 20, max: 49 },
		{ label: "50〜100", min: 50, max: 100 },
	],
};

/** 向きの当たりを数える点数の大きさ。中立の帯（-19〜19）の外 */
const DIRECTION_MIN = 20;

const round = (v: number, digits: number) => {
	const f = 10 ** digits;
	return Math.round(v * f) / f;
};

/** 価格の系列。time 以前に確定した最後の足の終値を返す */
export type PriceSeries = {
	timeframe: Timeframe | null;
	priceAt(time: number): number | null;
	returnsFrom(time: number): Returns;
};

export function priceSeries(
	candles: readonly Candle[],
	timeframe: Timeframe | null,
): PriceSeries {
	const tf = timeframe === null ? 0 : TIMEFRAME_MS[timeframe];
	// 足の終わりの時刻（昇順）
	const ends = candles.map((c) => c.time + tf);
	function priceAt(time: number): number | null {
		let lo = 0;
		let hi = ends.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if ((ends[mid] as number) <= time) lo = mid + 1;
			else hi = mid;
		}
		const i = lo - 1;
		if (i < 0) return null;
		// 欠損や最新の足より先の時刻は、前の足の終値で代用しない
		if (time - (ends[i] as number) >= tf) return null;
		return (candles[i] as Candle).close;
	}
	return {
		timeframe,
		priceAt,
		returnsFrom(time) {
			const p0 = priceAt(time);
			const r = {} as Returns;
			for (const h of HORIZON_KEYS) {
				const p1 = p0 === null ? null : priceAt(time + HORIZONS[h]);
				r[h] =
					p0 === null || p1 === null ? null : round((p1 / p0 - 1) * 100, 3);
			}
			return r;
		},
	};
}

function pearson(xs: number[], ys: number[]): number | null {
	const n = xs.length;
	if (n < 3) return null;
	const mx = xs.reduce((a, b) => a + b, 0) / n;
	const my = ys.reduce((a, b) => a + b, 0) / n;
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	for (let i = 0; i < n; i++) {
		const dx = (xs[i] as number) - mx;
		const dy = (ys[i] as number) - my;
		sxy += dx * dy;
		sxx += dx * dx;
		syy += dy * dy;
	}
	if (sxx === 0 || syy === 0) return null;
	return round(sxy / Math.sqrt(sxx * syy), 3);
}

const mean = (xs: number[]) =>
	xs.length === 0 ? null : round(xs.reduce((a, b) => a + b, 0) / xs.length, 3);

/** 騰落率の集計。risk は向きではなく大きさを見るので絶対値の平均も出す */
function returnStats(rs: Returns[]) {
	const out = {} as Record<
		Horizon,
		{
			n: number;
			meanPct: number | null;
			upRatio: number | null;
			meanAbsPct: number | null;
		}
	>;
	for (const h of HORIZON_KEYS) {
		const v = rs.map((r) => r[h]).filter((x): x is number => x !== null);
		out[h] = {
			n: v.length,
			meanPct: mean(v),
			upRatio:
				v.length === 0
					? null
					: round(v.filter((x) => x > 0).length / v.length, 3),
			meanAbsPct: mean(v.map(Math.abs)),
		};
	}
	return out;
}

export type ScoredNewsView = AnalysisNewsRow & {
	/** 採点時刻からの騰落率（%）。採点済みでなければ null */
	returns: Returns | null;
};

export type TrialItem = {
	news: ScoredNewsView;
	trial: { scores: Scores; comment: string } | { error: string };
};

export type ScoringAnalysisService = ReturnType<typeof createScoringAnalysis>;

export function createScoringAnalysis({
	repo,
	marketData,
	judgments,
	scorer,
	now = Date.now,
}: {
	repo: ScoringAnalysisRepository;
	marketData: Pick<MarketDataService, "exportCandles">;
	judgments: Pick<JudgmentService, "series">;
	scorer: Pick<Scorer, "trial">;
	now?: () => number;
}) {
	/** [from, to) の時刻から24時間後までの値動き */
	function prices(from: number, to: number): PriceSeries {
		const start = from - HOUR;
		const end = Math.min(to, now()) + HORIZONS["24h"] + HOUR;
		const found = PRICE_TIMEFRAMES.flatMap((tf) => {
			const r = marketData.exportCandles(tf, start, end);
			return r ? [{ tf, ...r }] : [];
		});
		// 細かい足が期間の途中からしか無ければ（収集を始める前は取り込んだ1時間足だけなど）、期間の頭からある粗い足を使う
		const pick =
			found.find((x) => x.first <= from) ??
			found.reduce<(typeof found)[number] | undefined>(
				(a, x) => (a === undefined || x.first < a.first ? x : a),
				undefined,
			);
		if (!pick) return priceSeries([], null);
		const candles: Candle[] = [];
		for (const page of pick.pages) candles.push(...page);
		return priceSeries(candles, pick.tf);
	}

	function view(r: AnalysisNewsRow, p: PriceSeries): ScoredNewsView {
		return {
			...r,
			returns:
				r.status === "done" && r.scoredAt !== null
					? p.returnsFrom(r.scoredAt)
					: null,
		};
	}

	return {
		listNews(f: NewsFilter, offset: number, limit: number) {
			const { total, rows } = repo.news(f, offset, limit);
			const times = rows.flatMap((r) => r.scoredAt ?? []);
			const p =
				times.length === 0
					? priceSeries([], null)
					: prices(Math.min(...times), Math.max(...times) + 1);
			return {
				total,
				priceTimeframe: p.timeframe,
				items: rows.map((r) => view(r, p)),
			};
		},

		/** 採点済みのニュースの点数と、採点時刻からの値動きの関係。基準の版ごとに出す */
		evaluateScores(f: Omit<NewsFilter, "status">) {
			const rows = repo.scored(f);
			// rows は採点時刻の順
			const p = rows.length
				? prices(
						rows[0]?.scoredAt as number,
						(rows.at(-1)?.scoredAt as number) + 1,
					)
				: priceSeries([], null);
			const byVersion = new Map<number | null, AnalysisNewsRow[]>();
			for (const r of rows) {
				const list = byVersion.get(r.criteriaVersion) ?? [];
				list.push(r);
				byVersion.set(r.criteriaVersion, list);
			}
			const versions = [...byVersion.entries()].map(([version, list]) => {
				const withReturns = list.map((r) => ({
					r,
					ret: p.returnsFrom(r.scoredAt as number),
				}));
				const judges = {} as Record<Judge, unknown>;
				for (const j of JUDGES) {
					const scored = withReturns.filter((x) => x.r[j] !== null);
					const corr = {} as Record<Horizon, number | null>;
					const hit = {} as Record<
						Horizon,
						{ n: number; ratio: number | null }
					>;
					for (const h of HORIZON_KEYS) {
						const pairs = scored.filter((x) => x.ret[h] !== null);
						const xs = pairs.map((x) => x.r[j] as number);
						const ys = pairs.map((x) =>
							// risk は向きではなく値動きの大きさと比べる
							j === "risk"
								? Math.abs(x.ret[h] as number)
								: (x.ret[h] as number),
						);
						corr[h] = pearson(xs, ys);
						if (j !== "risk") {
							const directed = pairs.filter(
								(x) =>
									Math.abs(x.r[j] as number) >= DIRECTION_MIN && x.ret[h] !== 0,
							);
							const ok = directed.filter(
								(x) => (x.r[j] as number) > 0 === (x.ret[h] as number) > 0,
							).length;
							hit[h] = {
								n: directed.length,
								ratio:
									directed.length === 0 ? null : round(ok / directed.length, 3),
							};
						}
					}
					judges[j] = {
						count: scored.length,
						nullCount: list.length - scored.length,
						meanScore: mean(scored.map((x) => x.r[j] as number)),
						correlation: corr,
						...(j === "risk" ? {} : { directionHit: hit }),
						bands: BANDS[j].map((b) => {
							const inBand = scored.filter(
								(x) =>
									(x.r[j] as number) >= b.min && (x.r[j] as number) <= b.max,
							);
							return {
								band: b.label,
								count: inBand.length,
								returns: returnStats(inBand.map((x) => x.ret)),
							};
						}),
					};
				}
				return {
					criteriaVersion: version,
					count: list.length,
					models: [...new Set(list.map((r) => r.model))],
					judges,
				};
			});
			return {
				priceTimeframe: p.timeframe,
				newsCount: rows.length,
				baseline: returnStats(
					rows.map((r) => p.returnsFrom(r.scoredAt as number)),
				),
				versions,
			};
		},

		/** 1時間ごとの判定と、その時刻からの値動き。rule を渡すとそのルールで計算する（保存しない） */
		evaluateJudgments(from: number, to: number, rule?: AggregationRule) {
			const end = Math.min(to, now());
			const s = judgments.series(from, end, HOUR, rule);
			const p = prices(from, end);
			const points = s.values.sentiment.map((_, i) => ({
				time: Math.min(from + (i + 1) * HOUR, end),
				values: {
					sentiment: s.values.sentiment[i],
					risk: s.values.risk[i],
				} as Record<Judge, string | null>,
			}));
			const judged = points.filter((x) => x.values.sentiment !== null);
			const withReturns = judged.map((x) => ({
				...x,
				ret: p.returnsFrom(x.time),
			}));
			const byJudge = {} as Record<Judge, unknown>;
			for (const j of JUDGES) {
				const groups = new Map<string, Returns[]>();
				for (const x of withReturns) {
					const v = x.values[j] as string;
					const list = groups.get(v) ?? [];
					list.push(x.ret);
					groups.set(v, list);
				}
				byJudge[j] = [...groups.entries()].map(([value, rs]) => ({
					value,
					hours: rs.length,
					returns: returnStats(rs),
				}));
			}
			return {
				priceTimeframe: p.timeframe,
				hours: points.length,
				judgedHours: judged.length,
				firstScoredAt: s.firstScoredAt,
				baseline: returnStats(withReturns.map((x) => x.ret)),
				byJudge,
			};
		},

		/** 過去のニュースを採点の基準の案で採点し直す。保存も集計への反映もしない */
		async trial(
			criteria: string,
			newsIds: readonly number[],
		): Promise<
			{ ok: true; items: TrialItem[] } | { ok: false; message: string }
		> {
			const t = criteria.trim();
			if (!t) return { ok: false, message: "採点の基準を入れる" };
			if (t.length > CRITERIA_MAX)
				return { ok: false, message: `${CRITERIA_MAX} 文字以内にする` };
			const rows = repo.byIds(newsIds);
			if (rows.length === 0)
				return { ok: false, message: "ニュースが見つからない" };
			const times = rows.flatMap((r) => r.scoredAt ?? []);
			const p =
				times.length === 0
					? priceSeries([], null)
					: prices(Math.min(...times), Math.max(...times) + 1);
			const items: TrialItem[] = [];
			for (const r of rows) {
				const res = await scorer.trial(r, t);
				items.push({
					news: view(r, p),
					trial: res.ok ? res.result : { error: res.error },
				});
			}
			return { ok: true, items };
		},
	};
}
