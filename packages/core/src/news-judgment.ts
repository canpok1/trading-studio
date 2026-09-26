// ニュースごとの AI の点数から、ある時刻のトレンド・リスク・センチメントの判定を出す。AI は呼ばない

import type { ValidationError } from "./strategy";

export const JUDGES = ["trend", "risk", "sentiment"] as const;
export type Judge = (typeof JUDGES)[number];

export const JUDGE_LABELS: Record<Judge, string> = {
	trend: "トレンド",
	risk: "リスク",
	sentiment: "センチメント",
};

/** 判定の値。並びは画面の複数選択の並び */
export const JUDGMENT_VALUES = {
	trend: ["up", "range", "down"],
	risk: ["normal", "caution", "crisis"],
	sentiment: ["+2", "+1", "0", "-1", "-2"],
} as const satisfies Record<Judge, readonly string[]>;

export type JudgmentValue<J extends Judge = Judge> =
	(typeof JUDGMENT_VALUES)[J][number];

export const JUDGMENT_VALUE_LABELS: Record<string, string> = {
	up: "上昇",
	range: "レンジ",
	down: "下落",
	normal: "平常",
	caution: "警戒",
	crisis: "危機",
	"+2": "+2",
	"+1": "+1",
	"0": "0",
	"-1": "−1",
	"-2": "−2",
};

/** 期間内に対象が無いときの判定 */
export const NEUTRAL: { [J in Judge]: JudgmentValue<J> } = {
	trend: "range",
	risk: "normal",
	sentiment: "0",
};

/** 観点ごとの点数。0〜100 の整数、関係なしは null */
export type Scores = Record<Judge, number | null>;

/** 採点済みのニュース1件。採点に失敗したものは渡さない */
export type ScoredNews = {
	id: number;
	/** 公開時刻（RSS の値） */
	publishedAt: number;
	/** 取得時刻 */
	fetchedAt: number;
	/** 採点した時刻。これより前の評価時刻では使わない */
	scoredAt: number;
	scores: Scores;
};

/** 集計ルール。時間は時間単位の整数、しきい値は 0〜100 の整数 */
export type AggregationRule = {
	windowHours: number;
	halfLifeHours: number;
	thresholds: {
		/** up 以上=上昇、down 以下=下落 */
		trend: { up: number; down: number };
		/** caution 以上=警戒、crisis 以上=危機 */
		risk: { caution: number; crisis: number };
		/** plus2 以上=+2、plus1 以上=+1、minus1 未満=−1、minus2 未満=−2 */
		sentiment: { plus2: number; plus1: number; minus1: number; minus2: number };
	};
};

export const DEFAULT_AGGREGATION_RULE: AggregationRule = {
	windowHours: 24,
	halfLifeHours: 6,
	thresholds: {
		trend: { up: 60, down: 40 },
		risk: { caution: 40, crisis: 70 },
		sentiment: { plus2: 80, plus1: 60, minus1: 40, minus2: 20 },
	},
};

export const RULE_LIMITS = {
	hours: { min: 1, max: 168 },
	score: { min: 0, max: 100 },
} as const;

const HOUR = 3_600_000;

function isIntIn(v: unknown, r: { min: number; max: number }): v is number {
	return (
		Number.isInteger(v) && (v as number) >= r.min && (v as number) <= r.max
	);
}

/** 集計ルールの入力検証。path はフォームの項目（thresholds.trend.up など） */
export function validateAggregationRule(r: AggregationRule): ValidationError[] {
	const errors: ValidationError[] = [];
	const err = (path: string, message: string) => errors.push({ path, message });
	const h = RULE_LIMITS.hours;
	const s = RULE_LIMITS.score;
	for (const k of ["windowHours", "halfLifeHours"] as const) {
		if (!isIntIn(r[k], h)) err(k, `${h.min}〜${h.max} の整数で入れる`);
	}
	let scoresOk = true;
	for (const j of JUDGES) {
		for (const [k, v] of Object.entries(r.thresholds[j])) {
			if (!isIntIn(v, s)) {
				err(`thresholds.${j}.${k}`, `${s.min}〜${s.max} の整数で入れる`);
				scoresOk = false;
			}
		}
	}
	if (!scoresOk) return errors;
	const t = r.thresholds;
	if (t.trend.down >= t.trend.up) {
		err("thresholds.trend.down", `上昇（${t.trend.up}）より小さくする`);
	}
	if (t.risk.caution >= t.risk.crisis) {
		err("thresholds.risk.caution", `危機（${t.risk.crisis}）より小さくする`);
	}
	const se = t.sentiment;
	if (se.plus1 >= se.plus2) {
		err("thresholds.sentiment.plus1", `+2（${se.plus2}）より小さくする`);
	}
	if (se.minus1 > se.plus1) {
		err("thresholds.sentiment.minus1", `+1（${se.plus1}）以下にする`);
	}
	if (se.minus2 >= se.minus1) {
		err("thresholds.sentiment.minus2", `−1（${se.minus1}）より小さくする`);
	}
	return errors;
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
	return typeof v === "number" ? v : Number.NaN;
}

/** JSON から読む。形が違えば null。値の範囲は validateAggregationRule で見る */
export function parseAggregationRule(v: unknown): AggregationRule | null {
	if (!isObj(v) || !isObj(v.thresholds)) return null;
	const t = v.thresholds;
	if (!isObj(t.trend) || !isObj(t.risk) || !isObj(t.sentiment)) return null;
	return {
		windowHours: num(v.windowHours),
		halfLifeHours: num(v.halfLifeHours),
		thresholds: {
			trend: { up: num(t.trend.up), down: num(t.trend.down) },
			risk: { caution: num(t.risk.caution), crisis: num(t.risk.crisis) },
			sentiment: {
				plus2: num(t.sentiment.plus2),
				plus1: num(t.sentiment.plus1),
				minus1: num(t.sentiment.minus1),
				minus2: num(t.sentiment.minus2),
			},
		},
	};
}

/** ニュースの新しさを測る時刻。公開時刻が取得時刻より後（未来の日付）なら取得時刻 */
export function newsTime(n: Pick<ScoredNews, "publishedAt" | "fetchedAt">) {
	return Math.min(n.publishedAt, n.fetchedAt);
}

/** 平均点を判定に変える */
export function classify<J extends Judge>(
	judge: J,
	average: number,
	rule: AggregationRule,
): JudgmentValue<J> {
	const t = rule.thresholds;
	let v: JudgmentValue;
	switch (judge) {
		case "trend":
			v =
				average >= t.trend.up
					? "up"
					: average <= t.trend.down
						? "down"
						: "range";
			break;
		case "risk":
			v =
				average >= t.risk.crisis
					? "crisis"
					: average >= t.risk.caution
						? "caution"
						: "normal";
			break;
		default: {
			const s = t.sentiment;
			v =
				average >= s.plus2
					? "+2"
					: average >= s.plus1
						? "+1"
						: average < s.minus2
							? "-2"
							: average < s.minus1
								? "-1"
								: "0";
		}
	}
	return v as JudgmentValue<J>;
}

export type JudgeResult<J extends Judge = Judge> = {
	value: JudgmentValue<J>;
	/** 重み付き平均点。対象が無ければ null */
	average: number | null;
	/** 平均に使ったニュースの件数 */
	count: number;
};

export type JudgmentSnapshot = {
	time: number;
	results: { [J in Judge]: JudgeResult<J> };
	/** 期間内で評価時刻までに採点済みのニュースの重み（評価時刻に公開されたものが 1）。どの観点の平均にも使われないものも含む */
	weights: Map<number, number>;
};

function inWindow(n: ScoredNews, time: number, windowMs: number): boolean {
	return n.scoredAt <= time && newsTime(n) > time - windowMs;
}

function summarize(
	active: readonly ScoredNews[],
	time: number,
	rule: AggregationRule,
): JudgmentSnapshot["results"] {
	const halfLifeMs = rule.halfLifeHours * HOUR;
	const sum: Record<Judge, number> = { trend: 0, risk: 0, sentiment: 0 };
	const wsum: Record<Judge, number> = { trend: 0, risk: 0, sentiment: 0 };
	const count: Record<Judge, number> = { trend: 0, risk: 0, sentiment: 0 };
	for (const n of active) {
		const w = 0.5 ** ((time - newsTime(n)) / halfLifeMs);
		for (const j of JUDGES) {
			const s = n.scores[j];
			if (s === null) continue;
			sum[j] += w * s;
			wsum[j] += w;
			count[j] += 1;
		}
	}
	const result = <J extends Judge>(j: J): JudgeResult<J> => {
		if (count[j] === 0) {
			return { value: NEUTRAL[j], average: null, count: 0 };
		}
		const average = sum[j] / wsum[j];
		return { value: classify(j, average, rule), average, count: count[j] };
	};
	return {
		trend: result("trend"),
		risk: result("risk"),
		sentiment: result("sentiment"),
	};
}

/** ある時刻の判定。`採点時刻 <= time` かつ期間内のニュースだけを使う */
export function judgeAt(
	news: readonly ScoredNews[],
	time: number,
	rule: AggregationRule,
): JudgmentSnapshot {
	const windowMs = rule.windowHours * HOUR;
	const halfLifeMs = rule.halfLifeHours * HOUR;
	const active = news.filter((n) => inWindow(n, time, windowMs));
	const weights = new Map<number, number>();
	for (const n of active) {
		weights.set(n.id, 0.5 ** ((time - newsTime(n)) / halfLifeMs));
	}
	return { time, results: summarize(active, time, rule), weights };
}

export type JudgmentPoint = {
	time: number;
	values: { [J in Judge]: JudgmentValue<J> };
};

/**
 * 昇順の時刻の列それぞれの判定（チャート・バックテスト用）。
 * 重みはどのニュースも同じ割合で減るので、使うニュースが変わらない間は平均点も変わらない。
 * そのため使うニュースが入れ替わる時刻だけ計算し直す
 */
export function judgmentSeries(
	news: readonly ScoredNews[],
	times: readonly number[],
	rule: AggregationRule,
): JudgmentPoint[] {
	const windowMs = rule.windowHours * HOUR;
	// ニュースは [採点時刻, 新しさの時刻 + 期間) の間だけ使う
	const events: { at: number; news: ScoredNews; add: boolean }[] = [];
	for (const n of news) {
		const end = newsTime(n) + windowMs;
		if (n.scoredAt >= end) continue;
		events.push({ at: n.scoredAt, news: n, add: true });
		events.push({ at: end, news: n, add: false });
	}
	events.sort((a, b) => a.at - b.at);
	const active = new Set<ScoredNews>();
	let next = 0;
	let values: JudgmentPoint["values"] = { ...NEUTRAL };
	let prev = Number.NEGATIVE_INFINITY;
	const out: JudgmentPoint[] = [];
	for (const time of times) {
		if (time < prev) throw new RangeError("時刻は昇順で渡す");
		prev = time;
		let changed = false;
		while (
			next < events.length &&
			(events[next] as (typeof events)[0]).at <= time
		) {
			const e = events[next] as (typeof events)[0];
			next += 1;
			if (e.add) active.add(e.news);
			else active.delete(e.news);
			changed = true;
		}
		if (changed) {
			const r = summarize([...active], time, rule);
			values = {
				trend: r.trend.value,
				risk: r.risk.value,
				sentiment: r.sentiment.value,
			};
		}
		out.push({ time, values });
	}
	return out;
}
