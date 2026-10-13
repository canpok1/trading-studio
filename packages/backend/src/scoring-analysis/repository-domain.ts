import type { AccuracySettings, AnalysisNewsRow } from "./types-domain";

export interface ScoringAnalysisRepository {
	accuracySettings(): AccuracySettings;
	saveAccuracySettings(s: AccuracySettings): void;
	/**
	 * 採点済みのものを、新しさの時刻（公開時刻と取得時刻の早い方）が (from, to] の範囲で。from が null なら to 以前すべて。
	 * to より後に採点したものは、その時点ではまだ無かったので除く
	 */
	publishedBetween(from: number | null, to: number): AnalysisNewsRow[];
	/** ID で引く。無い ID は飛ばす。並びは ids の順 */
	byIds(ids: readonly number[]): AnalysisNewsRow[];
}
