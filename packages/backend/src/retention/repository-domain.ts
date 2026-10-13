import type {
	RetentionRun,
	RetentionSettings,
	RetentionTable,
} from "./types-domain";

export interface RetentionRepository {
	settings(): RetentionSettings;
	saveSettings(s: RetentionSettings): void;
	lastRun(): RetentionRun | null;
	saveLastRun(r: RetentionRun): void;
	/** before より前の判断の記録を最大 limit 件消す。注文を出した判断は残す。消した件数を返す */
	deleteDecisions(before: number, limit: number): number;
	/** before より前に始めたバックテストの実行を最大 limit 件、結果・アドバイスごと消す。含む実行が無くなったまとめた実行も消す。実行中・アドバイスの生成中は残す */
	deleteBacktests(before: number, limit: number): number;
	/** 開始が before より前の相場データを、相場ごとに最新の1件を残して消す。消した件数を返す */
	pruneSegments(before: number): number;
	/** 残っている相場データのために残す範囲（開始の SEGMENT_LEAD_MS 前から終了まで） */
	keptRanges(): {
		from: number;
		to: number;
	}[];
	/** 公開が [from, to) のニュースを最大 limit 件、採点・採点し直しごと消す。消した件数を返す */
	deleteNews(from: number, to: number, limit: number): number;
	/** ニュースを消した境目を覚える。境目より前は市場評価の記録が無いものとする（judgmentRecordStart） */
	markNewsDeletedBefore(before: number): void;
	/** DB ファイルの大きさと、そのうち空いている領域（バイト） */
	size(): {
		dbBytes: number;
		freeBytes: number;
	};
	tables(): RetentionTable[];
}
