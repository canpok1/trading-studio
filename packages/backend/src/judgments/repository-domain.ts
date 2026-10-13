// 市場評価が読み書きする採点の記録と評価ルール。実装はニュースの採点の記録（news のリポジトリ）

import type { AggregationRule, ScoredNews } from "@trading-studio/core";

export interface JudgmentRepository {
	/** 保存した評価ルール。無い・壊れていれば既定 */
	aggregationRule(): AggregationRule;
	setAggregationRule(rule: AggregationRule): void;
	/**
	 * 使い始める時刻が [from, to) の採点済みニュース。使い始める時刻は、delayMs が null なら運用の採点時刻、
	 * 数なら新しさの時刻に delayMs を足した時刻（バックテスト。docs/news.md）。version を渡すとその版の採点にする
	 */
	scoredNews(
		from: number,
		to: number,
		version?: number | null,
		delayMs?: number | null,
	): ScoredNews[];
	/** scoredNews と同じ記事の、データの最終更新時刻。記事が無ければ null。バックテストの結果に残す */
	newsDataVersion(
		from: number,
		to: number,
		version: number | null,
		delayMs: number,
	): number | null;
	/** 古いニュースを消した境目。消していなければ null */
	newsDeletedBefore(): number | null;
	/** 最初に採点した時刻。まだ無ければ null */
	firstScoredAt(): number | null;
}
