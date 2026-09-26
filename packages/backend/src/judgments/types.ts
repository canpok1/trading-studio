// AI 判定の API が使う型。app.ts から参照されるため、Bun 固有の型を持ち込まない

import type {
	AggregationRule,
	Judge,
	JudgeResult,
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

export interface JudgmentService {
	/** 今の判定。rule を渡すとそのルールで計算する（保存しない） */
	current(rule?: AggregationRule): CurrentJudgment;
	rule(): AggregationRule;
	saveRule(
		rule: AggregationRule,
	): { ok: true } | { ok: false; errors: ValidationError[] };
}
