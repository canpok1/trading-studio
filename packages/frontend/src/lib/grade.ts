// 成績の数値ごとの評価。バックテスト結果とホームの成績で同じ基準を使う

export type Grade = "excellent" | "good" | "fair" | "poor" | "bad";

export type GradeBadgeValue = { grade: Grade; label: string };

const LABEL: Record<Grade, string> = {
	excellent: "優秀",
	good: "良い",
	fair: "普通",
	poor: "悪い",
	bad: "非常に悪い",
};

const of = (grade: Grade): GradeBadgeValue => ({ grade, label: LABEL[grade] });

/**
 * 損益を、同じ期間ただ買って持っていた場合（ガチホ）の損益率と比べる。ガチホが分からなければ null。
 * 取引も保有も無い（何もしていない）なら普通に固定する。比べると、下げ相場で何もしなかっただけで良く出るため
 */
export function gradePnl(
	pnlPercent: number | null,
	buyHoldPercent: number | null,
	idle: boolean,
): GradeBadgeValue | null {
	if (pnlPercent === null || buyHoldPercent === null) return null;
	if (idle) return of("fair");
	if (pnlPercent >= 0) {
		if (pnlPercent - buyHoldPercent >= 5) return of("excellent");
		return of(pnlPercent >= buyHoldPercent ? "good" : "fair");
	}
	return of(pnlPercent >= buyHoldPercent ? "poor" : "bad");
}

/** 損益比率。取引が無ければ null。損失が無い（∞）なら優秀 */
export function gradeProfitFactor(
	profitFactor: number | null,
	trades: number,
): GradeBadgeValue | null {
	if (trades === 0) return null;
	if (profitFactor === null || profitFactor >= 2) return of("excellent");
	if (profitFactor >= 1.5) return of("good");
	if (profitFactor >= 1.2) return of("fair");
	if (profitFactor >= 1) return of("poor");
	return of("bad");
}

/** 最大ドローダウン（%、0 以上） */
export function gradeMaxDrawdown(percent: number): GradeBadgeValue {
	if (percent <= 5) return of("excellent");
	if (percent <= 10) return of("good");
	if (percent <= 20) return of("fair");
	if (percent <= 30) return of("poor");
	return of("bad");
}

/** 勝率（%）。取引が無ければ null */
export function gradeWinRate(winRate: number | null): GradeBadgeValue | null {
	if (winRate === null) return null;
	if (winRate >= 70) return of("excellent");
	if (winRate >= 60) return of("good");
	if (winRate >= 40) return of("fair");
	if (winRate >= 30) return of("poor");
	return of("bad");
}

/**
 * 取引が少なく、勝率・PF の評価が偶然の可能性があるときの注意文。無ければ null。
 * 適切な回数は戦略ごとに違うので、回数そのものは評価しない
 */
export function fewTradesNote(trades: number): string | null {
	if (trades === 0 || trades >= 30) return null;
	return `取引が${trades}回しかないため、勝率・PF の評価は偶然の可能性があります`;
}

/** 期間の最初の足の始値から最後の足の終値まで、ただ持っていた場合の損益率（%）。足が無ければ null */
export function buyHoldPercentOf(
	bars: readonly { close: number; open?: number }[],
): number | null {
	const first = bars[0];
	const last = bars.at(-1);
	if (!first || !last) return null;
	const base = first.open ?? first.close;
	return base > 0 ? (last.close / base - 1) * 100 : null;
}

/** 市場評価の精度を評価するのに要る件数。これ未満は偶然と区別できない */
export const PRECISION_MIN_SAMPLES = 30;

/** 精度のバッジ。件数が足りなければ「データ不足」 */
export type PrecisionBadgeValue =
	| GradeBadgeValue
	| { grade: "none"; label: string };

const insufficient = { grade: "none", label: "データ不足" } as const;

/**
 * センチメントの精度＝的中率（%）。強気・弱気の材料のうち、その後の値動きの向きが合った割合。
 * 偶然でも 50% 前後になるので、普通を 50% の前後に置く
 */
export function gradeSentimentPrecision(
	hitRate: number | null,
	samples: number,
): PrecisionBadgeValue {
	if (hitRate === null || samples < PRECISION_MIN_SAMPLES) return insufficient;
	if (hitRate >= 65) return of("excellent");
	if (hitRate >= 55) return of("good");
	if (hitRate >= 45) return of("fair");
	if (hitRate >= 35) return of("poor");
	return of("bad");
}

/**
 * リスクの精度＝見分け率（%）。荒れた側と静かな側の当たりの割合の平均で、
 * 当てずっぽうでも 50% になるため、センチメントと同じ基準で分ける
 */
export const gradeRiskPrecision = gradeSentimentPrecision;
