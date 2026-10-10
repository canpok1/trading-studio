// データセット（相場データをまとめたもの）の成績の合算。相場データごとに別々に実行した結果を合わせる

import type { BacktestSummary } from "./backtest";
import type { MarketRegime } from "./market-regime";
import { MARKET_REGIMES } from "./market-regime";

/** データセットに入れられる相場データの上限 */
export const MAX_DATASET_SEGMENTS = 24;

/** 合算に使う1件ぶんの結果 */
export type DatasetMember = {
	regime: MarketRegime;
	summary: BacktestSummary;
	/** 往復の取引ごとの損益（手数料込み） */
	tradePnls: readonly number[];
};

export type DatasetSummary = {
	/** 合算した相場データの数 */
	count: number;
	/** 全相場データの取引をまとめて数えた回数・勝ち・負け・勝率・損益比率（損失が無ければ null） */
	trades: number;
	wins: number;
	losses: number;
	winRate: number | null;
	profitFactor: number | null;
	/** 損益率の平均と、いちばん悪い相場データの損益率（%）。期間が重なりうるので足し合わせない */
	averagePnlPercent: number;
	worstPnlPercent: number;
	/** ガチホの損益率の平均（%）。持たない結果があれば null */
	averageBuyHoldPercent: number | null;
	/** 最大ドローダウンのうち最も大きいもの（%） */
	maxDrawdownPercent: number;
	/** 損益率がガチホ以上だった相場データの数。ガチホを持たない結果は数えない */
	beatBuyHold: number;
	/** どの相場データでも取引も保有も無かった */
	idle: boolean;
	/** 相場ごとの件数と損益率の平均。件数 0 の相場は入れない */
	byRegime: {
		regime: MarketRegime;
		count: number;
		averagePnlPercent: number;
	}[];
};

const average = (xs: readonly number[]) =>
	xs.reduce((a, x) => a + x, 0) / xs.length;

/** 結果が1件も無ければ null */
export function summarizeDataset(
	members: readonly DatasetMember[],
): DatasetSummary | null {
	if (members.length === 0) return null;
	const pnls = members.flatMap((m) => m.tradePnls);
	// 勝ち負けの数え方はバックテストの成績に合わせる（損益 0 は負け）
	const wins = pnls.filter((p) => p > 0);
	const grossProfit = wins.reduce((a, p) => a + p, 0);
	const grossLoss = -pnls.filter((p) => p <= 0).reduce((a, p) => a + p, 0);
	const pnlPercents = members.map((m) => m.summary.pnlPercent);
	const buyHolds = members.map((m) => m.summary.buyHoldPercent);
	return {
		count: members.length,
		trades: pnls.length,
		wins: wins.length,
		losses: pnls.length - wins.length,
		winRate: pnls.length ? (wins.length / pnls.length) * 100 : null,
		profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
		averagePnlPercent: average(pnlPercents),
		worstPnlPercent: Math.min(...pnlPercents),
		averageBuyHoldPercent: buyHolds.every((b) => b !== undefined)
			? average(buyHolds as number[])
			: null,
		maxDrawdownPercent: Math.max(
			...members.map((m) => m.summary.maxDrawdownPercent),
		),
		beatBuyHold: members.filter(
			(m) =>
				m.summary.buyHoldPercent !== undefined &&
				m.summary.pnlPercent >= m.summary.buyHoldPercent,
		).length,
		idle: members.every(
			(m) => m.summary.trades === 0 && m.summary.openPositionQuantity === 0,
		),
		byRegime: MARKET_REGIMES.flatMap((regime) => {
			const xs = members.filter((m) => m.regime === regime);
			return xs.length
				? [
						{
							regime,
							count: xs.length,
							averagePnlPercent: average(xs.map((m) => m.summary.pnlPercent)),
						},
					]
				: [];
		}),
	};
}

/** 期間が重なる組（[i, j] は periods の添字、i < j） */
export function overlappingPairs(
	periods: readonly { from: number; to: number }[],
): [number, number][] {
	const pairs: [number, number][] = [];
	for (let i = 0; i < periods.length; i++) {
		for (let j = i + 1; j < periods.length; j++) {
			const a = periods[i] as { from: number; to: number };
			const b = periods[j] as { from: number; to: number };
			if (a.from < b.to && b.from < a.to) pairs.push([i, j]);
		}
	}
	return pairs;
}

/**
 * 相場ごとに、期間が重ならないものを新しい順に最大 perRegime 件ずつ選び、新しい順で返す。segments は新しい順。
 * 数の少ない相場から選ぶ（多い相場の分で期間が埋まり、少ない相場が選べなくなるのを避ける）
 */
export function pickSpreadSegments<
	T extends { id: number; from: number; to: number; regime: MarketRegime },
>(segments: readonly T[], perRegime: number): T[] {
	const count = (r: MarketRegime) =>
		segments.filter((d) => d.regime === r).length;
	const regimes = [...MARKET_REGIMES].sort((a, b) => count(a) - count(b));
	const picked: T[] = [];
	for (const regime of regimes) {
		let n = 0;
		for (const d of segments) {
			if (n >= perRegime) break;
			if (d.regime !== regime) continue;
			if (picked.some((p) => p.from < d.to && d.from < p.to)) continue;
			picked.push(d);
			n++;
		}
	}
	return picked.sort((a, b) => b.from - a.from);
}
