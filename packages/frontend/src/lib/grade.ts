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

/** 損益を、同じ期間ただ買って持っていた場合（ガチホ）の損益率と比べる。ガチホが分からなければ null */
export function gradePnl(
	pnlPercent: number | null,
	buyHoldPercent: number | null,
): GradeBadgeValue | null {
	if (pnlPercent === null || buyHoldPercent === null) return null;
	if (pnlPercent > 0) {
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

/** 取引回数は良し悪しではなく、成績が偶然でないと言えるかの目安として3段階で出す */
export function gradeTrades(trades: number): GradeBadgeValue {
	if (trades >= 30) return { grade: "good", label: "十分" };
	if (trades >= 10) return { grade: "fair", label: "やや少ない" };
	return { grade: "poor", label: "少なすぎ" };
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
