// 相場データに付ける相場のラベル。閾値は GMO の BTC/JPY 日足（2021-10〜2026-10）の2か月の窓で、
// 乱高下が1割弱・残りがおよそ3等分になるように決めた（docs/adr/0024）

export type MarketRegime = "up" | "down" | "range" | "volatile";

export const MARKET_REGIMES: readonly MarketRegime[] = [
	"up",
	"down",
	"range",
	"volatile",
];

export function isMarketRegime(v: unknown): v is MarketRegime {
	return (MARKET_REGIMES as readonly unknown[]).includes(v);
}

export const MARKET_REGIME_LABELS: Record<MarketRegime, string> = {
	up: "上昇相場",
	down: "下落相場",
	range: "レンジ相場",
	volatile: "乱高下相場",
};

/** 日ごとの騰落率（終値の対数変化）の標準偏差がこれ以上なら乱高下（ppm） */
export const VOLATILE_PPM = 35_000;
/** 期間の騰落率がこれ以上なら上昇、これの負以下なら下落（ppm） */
export const TREND_PPM = 120_000;

export type RegimeResult = {
	regime: MarketRegime;
	/** 最初の足の始値から最後の足の終値までの騰落率（ppm） */
	returnPpm: number;
	/** 日ごとの騰落率の標準偏差（ppm） */
	volatilityPpm: number;
};

/** 日足（古い順）から相場を判定する。足が2本未満なら null */
export function classifyMarket(
	bars: readonly { open: number; close: number }[],
): RegimeResult | null {
	const first = bars[0];
	const last = bars[bars.length - 1];
	if (bars.length < 2 || !first || !last || first.open <= 0) return null;
	const changes: number[] = [];
	for (let i = 1; i < bars.length; i++) {
		const prev = bars[i - 1]?.close ?? 0;
		const cur = bars[i]?.close ?? 0;
		if (prev <= 0 || cur <= 0) return null;
		changes.push(Math.log(cur / prev));
	}
	const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
	const variance =
		changes.reduce((a, b) => a + (b - mean) ** 2, 0) / changes.length;
	const returnPpm = Math.round((last.close / first.open - 1) * 1_000_000);
	const volatilityPpm = Math.round(Math.sqrt(variance) * 1_000_000);
	const regime: MarketRegime =
		volatilityPpm >= VOLATILE_PPM
			? "volatile"
			: returnPpm >= TREND_PPM
				? "up"
				: returnPpm <= -TREND_PPM
					? "down"
					: "range";
	return { regime, returnPpm, volatilityPpm };
}

/** 相場データの期間の長さ（月） */
export const SEGMENT_MONTHS = 2;
/** 期間の分のうち、1分足がこの割合以上そろっていれば相場データを作る（ppm） */
export const SEGMENT_MIN_COVERAGE_PPM = 950_000;

const JST_MS = 9 * 3_600_000;

/** JST で time を含む月から months か月ずらした月の初め（JST 0:00） */
export function jstMonthStart(time: number, months = 0): number {
	const d = new Date(time + JST_MS);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1) - JST_MS;
}

/**
 * 相場データにする期間の候補。first を含む月から始まり、終わりが now の月の初め以前のものを、
 * 1か月ずつずらして古い順に返す
 */
export function segmentPeriods(
	first: number,
	now: number,
): { from: number; to: number }[] {
	const out: { from: number; to: number }[] = [];
	const limit = jstMonthStart(now);
	for (let i = 0; ; i++) {
		const from = jstMonthStart(first, i);
		const to = jstMonthStart(first, i + SEGMENT_MONTHS);
		if (to > limit) return out;
		out.push({ from, to });
	}
}

/**
 * 古いデータを消すときに、残す相場データの期間の開始より前にも残す長さ。
 * 市場評価は公開から長期の半減期の4倍まで遡って記事を使い、指標は期間より前の足で計算し始めるため
 */
export const SEGMENT_LEAD_MS = 31 * 86_400_000;

/**
 * 市場評価の記録の始まり。古いニュースを消した後は、消した境目から SEGMENT_LEAD_MS たつまでは
 * 遡って使う記事が欠けているので記録が無いものとする。
 * 相場データで選んだ期間は、その相場データのために開始の SEGMENT_LEAD_MS 前からニュースを残しているので、開始から
 */
export function judgmentRecordStart(
	firstScoredAt: number | null,
	newsDeletedBefore: number | null,
	segmentFrom: number | null = null,
): number | null {
	if (firstScoredAt === null || newsDeletedBefore === null) {
		return firstScoredAt;
	}
	const complete = newsDeletedBefore + SEGMENT_LEAD_MS;
	const kept =
		segmentFrom !== null && segmentFrom < complete ? segmentFrom : complete;
	return Math.max(firstScoredAt, kept);
}

/** (-∞, before) から keep の範囲を除いた範囲（古い順） */
export function rangesOutside(
	before: number,
	keep: readonly { from: number; to: number }[],
): { from: number; to: number }[] {
	const out: { from: number; to: number }[] = [];
	let cursor = Number.MIN_SAFE_INTEGER;
	for (const k of [...keep].sort((a, b) => a.from - b.from)) {
		if (cursor >= before) break;
		if (k.from > cursor)
			out.push({ from: cursor, to: Math.min(k.from, before) });
		cursor = Math.max(cursor, k.to);
	}
	if (cursor < before) out.push({ from: cursor, to: before });
	return out.filter((r) => r.from < r.to);
}
