// AI 判定の API が使う型。app.ts から参照されるため、Bun 固有の型を持ち込まない

import type {
	AggregationRule,
	Judge,
	JudgeResult,
	JudgmentValue,
	ScoredNews,
	ValidationError,
} from "@trading-studio/core";

export type CurrentJudgment = {
	time: number;
	rule: AggregationRule;
	results: { [J in Judge]: JudgeResult<J> };
	/** 期間内のニュースの重み（ニュースの ID → 0〜1） */
	weights: Record<string, number>;
	/** 最初に採点した時刻。まだ無ければ null */
	firstScoredAt: number | null;
};

/**
 * 足ごとの判定。i 番目は開始時刻 from + i * step の足で、その足の終わりの時刻の判定。
 * 採点の記録が始まる前の足は null
 */
export type JudgmentSeries = {
	from: number;
	step: number;
	firstScoredAt: number | null;
	values: { [J in Judge]: (JudgmentValue<J> | null)[] };
};

export interface JudgmentService {
	/** 今の判定。rule を渡すとそのルールで計算する（保存しない）。at を渡すとその時点の判定（先の時刻は今） */
	current(rule?: AggregationRule, at?: number): CurrentJudgment;
	/** [from, to) の足ごとの判定。rule を省くと今の集計ルール。version は scoredNews と同じ */
	series(
		from: number,
		to: number,
		step: number,
		rule?: AggregationRule,
		version?: number | null,
	): JudgmentSeries;
	rule(): AggregationRule;
	/** 最初に採点した時刻（採点の記録の始まり）。まだ無ければ null */
	firstScoredAt(): number | null;
	/** 採点時刻が [from, to) の採点済みのニュース。version を渡すとその版の採点だけを使う（無い記事は除く）。null・省略は運用どおり */
	scoredNews(from: number, to: number, version?: number | null): ScoredNews[];
	saveRule(
		rule: AggregationRule,
	): { ok: true } | { ok: false; errors: ValidationError[] };
}
