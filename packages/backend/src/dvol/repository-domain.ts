import type { DvolBar } from "./types-domain";

/** 取得の状態のうち、保存しておくもの */
export type DvolFetchState = {
	lastSuccessAt: number | null;
	lastError: string | null;
	errorSince: number | null;
};

export interface DvolRepository {
	/** 同じ時刻の足は上書きする（確定前の今の足を取り直すため） */
	save(bars: readonly DvolBar[]): void;
	latestTime(): number | null;
	/** 開始が [from, to) の足を古い順に */
	bars(from: number, to: number): DvolBar[];
	count(from: number, to: number): number;
	/** 開始が [from, to) の足を最大 limit 本消し、消した本数を返す */
	deleteBars(from: number, to: number, limit: number): number;
	fetchState(): DvolFetchState;
	recordSuccess(at: number): void;
	recordFailure(error: string, at: number): void;
}
