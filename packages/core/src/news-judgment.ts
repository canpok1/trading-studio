// ニュースごとの AI の点数から、ある時刻のセンチメント・リスクの判定を出す。AI は呼ばない

import type { ValidationError } from "./strategy";

export const JUDGES = ["sentiment", "risk"] as const;
export type Judge = (typeof JUDGES)[number];

export const JUDGE_LABELS: Record<Judge, string> = {
	sentiment: "センチメント",
	risk: "リスク",
};

/** 判定の値。並びは画面の複数選択の並び */
export const JUDGMENT_VALUES = {
	sentiment: ["+2", "+1", "0", "-1", "-2"],
	risk: ["calm", "mild", "alert", "severe", "crisis"],
} as const satisfies Record<Judge, readonly string[]>;

export type JudgmentValue<J extends Judge = Judge> =
	(typeof JUDGMENT_VALUES)[J][number];

/** 判定の条件だけで選べる値。採点の記録が始まる前で、判定がまだ無いこと */
export const NO_JUDGMENT = "none";

/** 判定の条件で選べる値。並びは画面の複数選択の並び */
export const JUDGMENT_CONDITION_VALUES = {
	sentiment: [...JUDGMENT_VALUES.sentiment, NO_JUDGMENT],
	risk: [...JUDGMENT_VALUES.risk, NO_JUDGMENT],
} as const satisfies Record<Judge, readonly string[]>;

export type JudgmentConditionValue<J extends Judge = Judge> =
	(typeof JUDGMENT_CONDITION_VALUES)[J][number];

export const JUDGMENT_VALUE_LABELS: Record<string, string> = {
	calm: "平常",
	mild: "やや警戒",
	alert: "警戒",
	severe: "かなり警戒",
	crisis: "危機",
	// リスクが3段階だった頃の値。取引の判断の記録に残っている
	normal: "平常",
	caution: "警戒",
	"+2": "かなり強気",
	"+1": "やや強気",
	"0": "中立",
	"-1": "やや弱気",
	"-2": "かなり弱気",
	none: "データなし",
};

/** 期間内に対象が無いときの判定 */
export const NEUTRAL: { [J in Judge]: JudgmentValue<J> } = {
	sentiment: "0",
	risk: "calm",
};

/** 観点ごとの点数の範囲。センチメントは 0 が中立の両側、リスクは 0 が安全の片側 */
export const SCORE_RANGES: Record<Judge, { min: number; max: number }> = {
	sentiment: { min: -100, max: 100 },
	risk: { min: 0, max: 100 },
};

/** 観点ごとの点数。SCORE_RANGES の範囲の整数。関係ない観点は 0 */
export type Scores = Record<Judge, number>;

/** 影響の持続。none は相場に関係ない記事で、集計に使わない（重み 0%） */
export const DURATIONS = ["none", "short", "medium", "long"] as const;
export type Duration = (typeof DURATIONS)[number];
/** 半減期を持つ持続 */
export type LastingDuration = Exclude<Duration, "none">;
export const LASTING_DURATIONS = [
	"short",
	"medium",
	"long",
] as const satisfies readonly LastingDuration[];

export const DURATION_LABELS: Record<Duration, string> = {
	none: "なし",
	short: "短期",
	medium: "中期",
	long: "長期",
};

/** 半減期の何倍たったら集計から外すか */
export const HALF_LIVES_IN_WINDOW = 4;

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
	duration: Duration;
};

/**
 * 評価ルール（画面の名前。コード上は集計ルール）。時間は時間単位の整数、しきい値は観点の点数の範囲（SCORE_RANGES）の整数。
 * 半減期は持続ごと。ニュースは半減期の HALF_LIVES_IN_WINDOW 倍たったら集計から外す
 */
export type AggregationRule = {
	halfLifeHours: Record<LastingDuration, number>;
	thresholds: {
		/** mild 以上=やや警戒、alert 以上=警戒、severe 以上=かなり警戒、crisis 以上=危機 */
		risk: { mild: number; alert: number; severe: number; crisis: number };
		/** plus2 以上=+2、plus1 以上=+1、minus1 未満=−1、minus2 未満=−2。画面では各値の下限として見せる（judgmentBands） */
		sentiment: { plus2: number; plus1: number; minus1: number; minus2: number };
	};
};

export const DEFAULT_AGGREGATION_RULE: AggregationRule = {
	halfLifeHours: { short: 6, medium: 24, long: 72 },
	thresholds: {
		risk: { mild: 20, alert: 40, severe: 55, crisis: 70 },
		sentiment: { plus2: 60, plus1: 20, minus1: -20, minus2: -60 },
	},
};

export const RULE_LIMITS = {
	hours: { min: 1, max: 168 },
} as const;

const HOUR = 3_600_000;

function isIntIn(v: unknown, r: { min: number; max: number }): v is number {
	return (
		Number.isInteger(v) && (v as number) >= r.min && (v as number) <= r.max
	);
}

/** 評価基準の1区間。下限〜上限（両端を含む整数）。下限が上限より大きければ当てはまる点数が無い */
export type JudgmentBand<J extends Judge = Judge> = {
	value: JudgmentValue<J>;
	min: number;
	max: number;
	/** 下限を決めるしきい値の項目。一番下の区間は点数の範囲の下端で決まるので無い */
	key: string | null;
};

/**
 * 評価基準を重ならない区間で表す。上の区間から順に並べる。
 * 平均点は整数に丸めてから比べるので、整数の区間で過不足なく表せる
 */
export function judgmentBands<J extends Judge>(
	judge: J,
	rule: AggregationRule,
): JudgmentBand<J>[] {
	const { min, max } = SCORE_RANGES[judge];
	const lowers: [string, string | null, number][] =
		judge === "risk"
			? [
					["crisis", "crisis", rule.thresholds.risk.crisis],
					["severe", "severe", rule.thresholds.risk.severe],
					["alert", "alert", rule.thresholds.risk.alert],
					["mild", "mild", rule.thresholds.risk.mild],
					["calm", null, min],
				]
			: [
					["+2", "plus2", rule.thresholds.sentiment.plus2],
					["+1", "plus1", rule.thresholds.sentiment.plus1],
					["0", "minus1", rule.thresholds.sentiment.minus1],
					["-1", "minus2", rule.thresholds.sentiment.minus2],
					["-2", null, min],
				];
	return lowers.map(([value, key, lower], i) => ({
		value: value as JudgmentValue<J>,
		min: lower,
		max: i === 0 ? max : (lowers[i - 1]?.[2] as number) - 1,
		key,
	}));
}

/** 評価ルールの入力検証。path はフォームの項目（thresholds.risk.caution など） */
export function validateAggregationRule(r: AggregationRule): ValidationError[] {
	const errors: ValidationError[] = [];
	const err = (path: string, message: string) => errors.push({ path, message });
	const h = RULE_LIMITS.hours;
	const hl = r.halfLifeHours;
	const hoursOk = LASTING_DURATIONS.filter((d) => {
		if (isIntIn(hl[d], h)) return true;
		err(`halfLifeHours.${d}`, `${h.min}〜${h.max} の整数で入れる`);
		return false;
	});
	// 持続の長さの順を崩すと、短期の記事のほうが長く効いて名前と食い違う
	if (hoursOk.length === LASTING_DURATIONS.length) {
		if (hl.medium < hl.short) err("halfLifeHours.medium", "短期以上にする");
		if (hl.long < hl.medium) err("halfLifeHours.long", "中期以上にする");
	}
	let scoresOk = true;
	for (const j of JUDGES) {
		const s = SCORE_RANGES[j];
		for (const [k, v] of Object.entries(r.thresholds[j])) {
			if (!isIntIn(v, s)) {
				err(`thresholds.${j}.${k}`, `${s.min}〜${s.max} の整数で入れる`);
				scoresOk = false;
			}
		}
	}
	if (!scoresOk) return errors;
	const t = r.thresholds;
	// やや警戒・かなり警戒は、3段階だった頃のルールを読み替えたときに範囲が無くなることがあるので、範囲なしにできる
	const rk = t.risk;
	if (rk.mild > rk.alert) {
		err("thresholds.risk.mild", `警戒の下限（${rk.alert}）以下にする`);
	}
	if (rk.alert >= rk.severe) {
		err(
			"thresholds.risk.alert",
			`かなり警戒の下限（${rk.severe}）より小さくする`,
		);
	}
	if (rk.severe > rk.crisis) {
		err("thresholds.risk.severe", `危機の下限（${rk.crisis}）以下にする`);
	}
	const se = t.sentiment;
	if (se.plus1 >= se.plus2) {
		err(
			"thresholds.sentiment.plus1",
			`かなり強気の下限（${se.plus2}）より小さくする`,
		);
	}
	if (se.minus1 > se.plus1) {
		err(
			"thresholds.sentiment.minus1",
			`やや強気の下限（${se.plus1}）以下にする`,
		);
	}
	if (se.minus2 >= se.minus1) {
		err(
			"thresholds.sentiment.minus2",
			`中立の下限（${se.minus1}）より小さくする`,
		);
	}
	return errors;
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
	return typeof v === "number" ? v : Number.NaN;
}

/**
 * JSON から読む。形が違えば null。値の範囲は validateAggregationRule で見る。
 * 半減期が1つだけの古い形（windowHours と数値の halfLifeHours）は、その半減期を短期にし、中期・長期は既定値（短期より短ければ短期と同じ）にする。
 * リスクが3段階（caution・crisis）だった頃の形は、警戒・危機の下限をそのまま残し、やや警戒の下限を警戒の下限の半分（切り捨て）、かなり警戒の下限を警戒と危機の下限の中間（切り上げ）に置く。警戒は範囲が残り、旧形が正しければ検証を通る（legacyRiskValues と合わせて判定が変わらない）
 */
export function parseAggregationRule(v: unknown): AggregationRule | null {
	if (!isObj(v) || !isObj(v.thresholds)) return null;
	const t = v.thresholds;
	if (!isObj(t.risk) || !isObj(t.sentiment)) return null;
	let halfLifeHours: AggregationRule["halfLifeHours"];
	if (isObj(v.halfLifeHours)) {
		const h = v.halfLifeHours;
		halfLifeHours = {
			short: num(h.short),
			medium: num(h.medium),
			long: num(h.long),
		};
	} else if (typeof v.halfLifeHours === "number") {
		const short = v.halfLifeHours;
		const d = DEFAULT_AGGREGATION_RULE.halfLifeHours;
		halfLifeHours = {
			short,
			medium: Math.max(d.medium, short),
			long: Math.max(d.long, short),
		};
	} else {
		return null;
	}
	return {
		halfLifeHours,
		thresholds: {
			risk: parseRiskThresholds(t.risk),
			sentiment: {
				plus2: num(t.sentiment.plus2),
				plus1: num(t.sentiment.plus1),
				minus1: num(t.sentiment.minus1),
				minus2: num(t.sentiment.minus2),
			},
		},
	};
}

function parseRiskThresholds(
	r: Record<string, unknown>,
): AggregationRule["thresholds"]["risk"] {
	if (r.alert === undefined && r.caution !== undefined) {
		const alert = num(r.caution);
		const crisis = num(r.crisis);
		return {
			mild: Math.floor(alert / 2),
			alert,
			severe: Math.ceil((alert + crisis) / 2),
			crisis,
		};
	}
	return {
		mild: num(r.mild),
		alert: num(r.alert),
		severe: num(r.severe),
		crisis: num(r.crisis),
	};
}

/**
 * リスクが3段階だった頃の条件の値を5段階の値に置き換える。parseAggregationRule の置き換えと合わせると、同じ点数で同じ結果になる。
 * 平常→平常・やや警戒、警戒→警戒・かなり警戒。それ以外（危機・データなし・今の値）はそのまま
 */
export function legacyRiskValues(values: readonly string[]): string[] {
	const out = values.flatMap((v) =>
		v === "normal"
			? ["calm", "mild"]
			: v === "caution"
				? ["alert", "severe"]
				: [v],
	);
	return [...new Set(out)];
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
		case "risk":
			v =
				average >= t.risk.crisis
					? "crisis"
					: average >= t.risk.severe
						? "severe"
						: average >= t.risk.alert
							? "alert"
							: average >= t.risk.mild
								? "mild"
								: "calm";
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
	/** 重み付き平均点（整数に丸める）。対象が無ければ null */
	average: number | null;
	/** 平均に使ったニュースの件数 */
	count: number;
};

export type JudgmentSnapshot = {
	time: number;
	results: { [J in Judge]: JudgeResult<J> };
	/** 重みが 0 より大きいニュースの重み（評価時刻に公開されたものが 1） */
	weights: Map<number, number>;
};

/** 集計に使う長さ（ミリ秒）。持続 none は 0 */
export function windowMs(duration: Duration, rule: AggregationRule): number {
	return duration === "none"
		? 0
		: rule.halfLifeHours[duration] * HALF_LIVES_IN_WINDOW * HOUR;
}

/** 一番長く集計に使う長さ（ミリ秒）。この長さより前のニュースはどの時刻の判定にも使わない */
export function maxWindowMs(rule: AggregationRule): number {
	return Math.max(...LASTING_DURATIONS.map((d) => windowMs(d, rule)));
}

/**
 * ある時刻のニュースの重み。新しさの時刻に 1 で、持続の半減期ごとに半分になる。
 * 採点前・持続 none・半減期の HALF_LIVES_IN_WINDOW 倍たったものは 0（集計に使わない）
 */
export function newsWeight(
	n: ScoredNews,
	time: number,
	rule: AggregationRule,
): number {
	if (n.duration === "none" || n.scoredAt > time) return 0;
	const age = time - newsTime(n);
	if (age >= windowMs(n.duration, rule)) return 0;
	return 0.5 ** (age / (rule.halfLifeHours[n.duration] * HOUR));
}

function summarize(
	active: readonly ScoredNews[],
	time: number,
	rule: AggregationRule,
): JudgmentSnapshot["results"] {
	const sum: Record<Judge, number> = { sentiment: 0, risk: 0 };
	let wsum = 0;
	let count = 0;
	for (const n of active) {
		const w = newsWeight(n, time, rule);
		if (w === 0) continue;
		wsum += w;
		count += 1;
		for (const j of JUDGES) sum[j] += w * n.scores[j];
	}
	return resultsOf(sum, wsum, count, rule);
}

function resultsOf(
	sum: Record<Judge, number>,
	wsum: number,
	count: number,
	rule: AggregationRule,
): JudgmentSnapshot["results"] {
	const result = <J extends Judge>(j: J): JudgeResult<J> => {
		if (count === 0) {
			return { value: NEUTRAL[j], average: null, count: 0 };
		}
		// 画面に出す整数の点数と判定を揃えるため、整数に丸めてからしきい値と比べる。
		// 重みの小数計算の誤差で .5 ちょうどの丸めが評価時刻によって揺れないよう、先に小数6桁で丸める
		const average = Math.round(Math.round((sum[j] / wsum) * 1e6) / 1e6);
		return { value: classify(j, average, rule), average, count };
	};
	return {
		sentiment: result("sentiment"),
		risk: result("risk"),
	};
}

/** ある時刻の判定。重みが 0 より大きいニュースだけを使う */
export function judgeAt(
	news: readonly ScoredNews[],
	time: number,
	rule: AggregationRule,
): JudgmentSnapshot {
	const weights = new Map<number, number>();
	const active: ScoredNews[] = [];
	for (const n of news) {
		const w = newsWeight(n, time, rule);
		if (w === 0) continue;
		weights.set(n.id, w);
		active.push(n);
	}
	return { time, results: summarize(active, time, rule), weights };
}

/** 市場評価の内訳の1行。記事の点数を評価基準で段階にしたときの、その段階の記事 */
export type BreakdownRow<J extends Judge = Judge> = {
	value: JudgmentValue<J>;
	/** 記事の件数 */
	count: number;
	/** 重みの合計に占める割合（0〜1）。記事が無ければ 0 */
	share: number;
};

/**
 * 判定に使った記事（重みが 0 より大きいもの）を、観点ごとに記事の点数の段階へ分けた件数と重みの割合。
 * 段階は評価基準の上の値から順（judgmentBands と同じ並び）。件数 0 の段階も出す
 */
export function judgmentBreakdown(
	news: readonly ScoredNews[],
	weights: ReadonlyMap<number, number>,
	rule: AggregationRule,
): { [J in Judge]: BreakdownRow<J>[] } {
	const rows = <J extends Judge>(j: J): BreakdownRow<J>[] => {
		const acc = new Map<string, { count: number; weight: number }>();
		let total = 0;
		for (const n of news) {
			const w = weights.get(n.id) ?? 0;
			if (w <= 0) continue;
			const v = classify(j, n.scores[j], rule);
			const a = acc.get(v) ?? { count: 0, weight: 0 };
			a.count += 1;
			a.weight += w;
			acc.set(v, a);
			total += w;
		}
		return judgmentBands(j, rule).map(({ value }) => {
			const a = acc.get(value);
			return {
				value,
				count: a?.count ?? 0,
				share: a && total > 0 ? a.weight / total : 0,
			};
		});
	};
	return { sentiment: rows("sentiment"), risk: rows("risk") };
}

export type JudgmentPoint = {
	time: number;
	values: { [J in Judge]: JudgmentValue<J> };
};

/**
 * 昇順に進む時刻ごとの判定を順に出す（バックテストの評価のたびに呼ぶ）。
 * 使うニュースが入れ替わる時刻だけ記事ごとに計算し、その間は半減期ごとの和から平均を出す。
 * 半減期が1種類なら平均点も変わらないので計算しない
 */
export function judgmentCursor(
	news: readonly ScoredNews[],
	rule: AggregationRule,
): (time: number) => JudgmentPoint["values"] {
	// ニュースは [採点時刻, 新しさの時刻 + 集計に使う長さ) の間だけ使う
	const events: { at: number; news: ScoredNews; add: boolean }[] = [];
	for (const n of news) {
		const end = newsTime(n) + windowMs(n.duration, rule);
		if (n.scoredAt >= end) continue;
		events.push({ at: n.scoredAt, news: n, add: true });
		events.push({ at: end, news: n, add: false });
	}
	events.sort((a, b) => a.at - b.at);
	const active = new Set<ScoredNews>();
	let next = 0;
	let values: JudgmentPoint["values"] = { ...NEUTRAL };
	// 半減期ごとに、基準の時刻 at での重みの和と重み付きの点数の和。同じ半減期の記事は重みが同じ割合で減るので、
	// 時刻 t ではどちらにも 0.5 ** ((t - at) / 半減期) を掛ければよい。使う記事が変わったときだけ作り直す
	let groups: {
		halfLifeMs: number;
		at: number;
		wsum: number;
		sum: Record<Judge, number>;
	}[] = [];
	let count = 0;
	let prev = Number.NEGATIVE_INFINITY;
	return (time) => {
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
			const byHalfLife = new Map<number, (typeof groups)[0]>();
			for (const n of active) {
				const halfLifeMs =
					rule.halfLifeHours[n.duration as LastingDuration] * HOUR;
				let g = byHalfLife.get(halfLifeMs);
				if (!g) {
					g = { halfLifeMs, at: time, wsum: 0, sum: { sentiment: 0, risk: 0 } };
					byHalfLife.set(halfLifeMs, g);
				}
				const w = newsWeight(n, time, rule);
				g.wsum += w;
				for (const j of JUDGES) g.sum[j] += w * n.scores[j];
			}
			groups = [...byHalfLife.values()];
			count = active.size;
		}
		if (changed || groups.length > 1) {
			const sum: Record<Judge, number> = { sentiment: 0, risk: 0 };
			let wsum = 0;
			for (const g of groups) {
				const f = 0.5 ** ((time - g.at) / g.halfLifeMs);
				wsum += f * g.wsum;
				for (const j of JUDGES) sum[j] += f * g.sum[j];
			}
			const r = resultsOf(sum, wsum, count, rule);
			values = {
				sentiment: r.sentiment.value,
				risk: r.risk.value,
			};
		}
		return values;
	};
}

/** 昇順の時刻の列それぞれの判定（チャート用） */
export function judgmentSeries(
	news: readonly ScoredNews[],
	times: readonly number[],
	rule: AggregationRule,
): JudgmentPoint[] {
	const at = judgmentCursor(news, rule);
	return times.map((time) => ({ time, values: at(time) }));
}
