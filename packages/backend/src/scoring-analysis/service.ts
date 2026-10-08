// 市場評価の精度。AI の採点が、その後の値動きと合っていたかを記事ごとに測り、集計する（docs/news-page.md）

import type {
	Candle,
	Judge,
	JudgmentValue,
	Timeframe,
} from "@trading-studio/core";
import {
	JUDGMENT_VALUES,
	classify as judgmentOf,
	newsTime,
	TIMEFRAME_MS,
} from "@trading-studio/core";
import type { JudgmentService } from "../judgments/types";
import type { MarketDataService } from "../market-data/types";
import { actualLevels, articlePrecision } from "./accuracy";
import type { AnalysisNewsRow, ScoringAnalysisRepository } from "./repository";
import type {
	AccuracySettings,
	AccuracySummary,
	AccuracySummaryResult,
	ArticleAccuracy,
	ArticleAccuracyReport,
	SetAccuracySettingsResult,
} from "./types";
import {
	ACCURACY_BAND_MAX,
	ACCURACY_HORIZONS,
	ACCURACY_PERIODS,
} from "./types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** 段階の境目が 0 < 小さい順に増える ≦ 上限 か */
const validBands = (b: readonly number[]) =>
	b.every(
		(v, i) => Number.isFinite(v) && v > (i === 0 ? 0 : (b[i - 1] as number)),
	) && (b[b.length - 1] as number) <= ACCURACY_BAND_MAX;

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

export type ScoringAnalysisService = ReturnType<typeof createScoringAnalysis>;

export function createScoringAnalysis({
	repo,
	marketData,
	judgments,
	now = Date.now,
}: {
	repo: ScoringAnalysisRepository;
	marketData: Pick<MarketDataService, "exportCandles">;
	judgments: Pick<JudgmentService, "rule">;
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

	/** 記事ごとの精度。採点済みでない記事・持続なしの記事は飛ばす */
	/** 記事ごとの精度。精度を出せた記事には値動きの段階の番号（0〜4）も付ける（集計の表に使う） */
	function measure(all: readonly AnalysisNewsRow[]): (
		| ArticleAccuracy
		| (Extract<ArticleAccuracy, { status: "ok" }> & {
				moves: { sentiment: number; risk: number };
		  })
	)[] {
		const { horizon, sentimentBands, riskBands } = repo.accuracySettings();
		const rule = judgments.rule();
		const rows = all.filter(
			(r) =>
				r.status === "done" &&
				r.scoredAt !== null &&
				r.sentiment !== null &&
				r.risk !== null &&
				r.duration !== "none",
		);
		// 「すべて」の期間では件数が多くなるので、引数に展開する Math.min(...) は使わない
		let first = Number.POSITIVE_INFINITY;
		let last = Number.NEGATIVE_INFINITY;
		for (const r of rows) {
			first = Math.min(first, newsTime(r));
			last = Math.max(last, newsTime(r));
		}
		const to = now();
		const p =
			rows.length === 0 ? priceSeries([], null) : prices(first, last + 1);
		const bands = {
			sentiment: sentimentBands[horizon],
			risk: riskBands[horizon],
		};
		return rows.map((r) => {
			// 市場の人が記事を知るのは公開から。採点を待つ分は点数の当たり外れと関係ないので含めない
			const at = newsTime(r);
			if (at + HORIZONS[horizon] > to) return { id: r.id, status: "measuring" };
			const ret = p.returnsFrom(at)[horizon];
			// 測る時刻の足は確定して取り込まれるまで少し遅れるので、その間は測定中にしておく
			if (ret === null)
				return {
					id: r.id,
					status: at + HORIZONS[horizon] + HOUR > to ? "measuring" : "unknown",
				};
			return {
				id: r.id,
				status: "ok",
				...articlePrecision(
					{ sentiment: r.sentiment as number, risk: r.risk as number },
					ret,
					rule,
					bands,
				),
				moves: actualLevels(ret, bands),
			};
		});
	}

	return {
		/** 記事ごとの精度（ニュース画面）。運用の採点の点数と、新しさの時刻（公開時刻）から設定の長さの後の値動きを突き合わせる */
		articleAccuracy(ids: readonly number[]): ArticleAccuracyReport {
			const { horizon } = repo.accuracySettings();
			// 値動きの段階は集計の表にだけ使うので、記事ごとの精度には載せない
			const items = measure(repo.byIds(ids)).map(
				(x): ArticleAccuracy =>
					x.status === "ok"
						? {
								id: x.id,
								status: x.status,
								sentiment: x.sentiment,
								risk: x.risk,
							}
						: x,
			);
			return { horizon, items };
		},

		/** 評価詳細のタブの精度の集計。新しさの時刻（公開時刻）が期間内の記事の精度を、観点ごとに 5〜1 で数える */
		accuracySummary(at?: number): AccuracySummary {
			const { horizon, periodDays } = repo.accuracySettings();
			const time = at ?? now();
			const from = periodDays === null ? null : time - periodDays * DAY;
			const rows = repo.publishedBetween(from, time);
			const byId = new Map(rows.map((r) => [r.id, r]));
			const rule = judgments.rule();
			const ok = measure(rows).flatMap((x) =>
				x.status === "ok" && "moves" in x ? [x] : [],
			);
			const summarize = <J extends Judge>(j: J): AccuracySummaryResult<J> => {
				const items = ok.map((x) => {
					const r = byId.get(x.id) as AnalysisNewsRow;
					return {
						precision: x[j],
						move: x.moves[j],
						value: judgmentOf(j, r[j] as number, rule),
					};
				});
				const values = JUDGMENT_VALUES[j] as readonly JudgmentValue<J>[];
				return {
					count: items.length,
					average:
						items.length === 0
							? null
							: round(
									items.reduce((a, x) => a + x.precision, 0) / items.length,
									1,
								),
					rows: [5, 4, 3, 2, 1].map((precision) => {
						const at = items.filter((x) => x.precision === precision);
						return {
							precision,
							count: at.length,
							levels: values.map((value) => ({
								value,
								count: at.filter((x) => x.value === value).length,
							})),
						};
					}),
					matrix: values.map((value) => {
						const moves = [0, 0, 0, 0, 0];
						for (const x of items)
							if (x.value === value) moves[x.move] = (moves[x.move] ?? 0) + 1;
						return { value, moves };
					}),
				};
			};
			const results = {
				sentiment: summarize("sentiment"),
				risk: summarize("risk"),
			};
			return { horizon, periodDays, time, results };
		},

		accuracySettings(): AccuracySettings {
			return repo.accuracySettings();
		},

		setAccuracySettings(s: AccuracySettings): SetAccuracySettingsResult {
			if (!ACCURACY_HORIZONS.includes(s.horizon))
				return {
					ok: false,
					field: "horizon",
					message: `測る長さは ${ACCURACY_HORIZONS.join(" か ")}`,
				};
			if (!ACCURACY_PERIODS.includes(s.periodDays))
				return {
					ok: false,
					field: "periodDays",
					message: "集計する期間は 7・30・90 日かすべて",
				};
			for (const h of ACCURACY_HORIZONS) {
				const b = s.sentimentBands?.[h];
				if (!b || !validBands([b.small, b.large]))
					return {
						ok: false,
						field: "sentimentBands",
						message: `センチメントの境目は 0 より大きく、小さい方 < 大きい方 ≦ ${ACCURACY_BAND_MAX}%`,
					};
				const r = s.riskBands?.[h];
				if (!r || !validBands([r.slight, r.rough, r.heavy, r.wild]))
					return {
						ok: false,
						field: "riskBands",
						message: `リスクの境目は 0 より大きく、やや荒れ < 荒れた < かなり荒れ < 大荒れ ≦ ${ACCURACY_BAND_MAX}%`,
					};
			}
			repo.saveAccuracySettings({
				horizon: s.horizon,
				sentimentBands: Object.fromEntries(
					ACCURACY_HORIZONS.map((h) => [
						h,
						{
							small: s.sentimentBands[h].small,
							large: s.sentimentBands[h].large,
						},
					]),
				) as AccuracySettings["sentimentBands"],
				riskBands: Object.fromEntries(
					ACCURACY_HORIZONS.map((h) => {
						const r = s.riskBands[h];
						return [
							h,
							{
								slight: r.slight,
								rough: r.rough,
								heavy: r.heavy,
								wild: r.wild,
							},
						];
					}),
				) as AccuracySettings["riskBands"],
				periodDays: s.periodDays,
			});
			return { ok: true };
		},
	};
}
