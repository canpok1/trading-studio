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

/**
 * 精度の評価。grade は値が出せなければ null。
 * insufficient は件数が足りず偶然と区別できないこと。そのときも評価は出し、添えて示す
 */
export type PrecisionGrade = {
	grade: GradeBadgeValue | null;
	insufficient: boolean;
};

type Cutoffs = readonly [number, number, number, number];

const gradeByCutoffs = (rate: number, c: Cutoffs): Grade =>
	rate >= c[0]
		? "excellent"
		: rate >= c[1]
			? "good"
			: rate >= c[2]
				? "fair"
				: rate >= c[3]
					? "poor"
					: "bad";

/**
 * 得点率（%）の評価。当てずっぽうの得点率が普通に入るよう、観点ごとに基準を置く。
 * センチメントは常に中立で 40%・でたらめで 36%、リスクは常に平常で 50%・でたらめで 56%
 */
const CUTOFFS = {
	sentiment: [55, 45, 35, 25],
	risk: [70, 60, 50, 40],
} as const satisfies Record<string, Cutoffs>;

export function gradePrecision(
	judge: keyof typeof CUTOFFS,
	rate: number | null,
	/** 数えた記事の件数 */
	samples: number,
	/** 記事の無い値動きの段階があるか。その段階の当たり外れが分からない */
	emptyLevel: boolean,
	/** これ未満は偶然と区別できない。精度の設定で変える */
	minSamples: number,
): PrecisionGrade {
	return {
		grade: rate === null ? null : of(gradeByCutoffs(rate, CUTOFFS[judge])),
		insufficient: samples < minSamples || emptyLevel,
	};
}
