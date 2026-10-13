// 過去データの API が使う型。app.ts から参照されるため、Bun 固有の型を持ち込まない

import type { Candle, CsvRowError, Gap, Timeframe } from "@trading-studio/core";

export type ImportStatus = "running" | "done" | "failed" | "canceled";
/**
 * validating: 検証中 / confirming: 既存の足と重なるので、上書きするかの選択を待っている /
 * saving: 保存中 / deriving: 粗い粒度の足を作成中
 */
export type ImportPhase = "validating" | "confirming" | "saving" | "deriving";

/** 取り込む足のうち、既存の足（取り込んだ・収集した足）と同じ日時のもの */
export type ImportOverlap = {
	/** 重なる最初の足の開始時刻 */
	from: number;
	/** 重なる最後の足の開始時刻 */
	to: number;
	count: number;
};

export type ImportJob = {
	id: number;
	timeframe: Timeframe;
	fileName: string;
	status: ImportStatus;
	phase: ImportPhase | null;
	/** 処理済みの行数（phase ごとに 0 から数える） */
	processedRows: number;
	totalRows: number;
	insertedRows: number;
	skippedRows: number;
	derivedRows: number;
	startedAt: number;
	finishedAt: number | null;
	firstTime: number | null;
	lastTime: number | null;
	/** 既存の足との重なり。重なりが無い・調べる前は null */
	overlap: ImportOverlap | null;
	/** 重なる足を上書きするか。選ぶ前・重なりが無いときは null */
	overwrite: boolean | null;
	/** 失敗の理由 */
	message: string | null;
	errors: CsvRowError[];
	errorCount: number;
};

export type TimeframeCoverage = {
	timeframe: Timeframe;
	count: number;
	/** 取り込んだ・収集した（自動で作っていない）足の数 */
	importedCount: number;
	firstTime: number | null;
	/** 最後の足の開始時刻 */
	lastTime: number | null;
	gaps: Gap[];
	/** gaps が多いときは先頭から切り詰める。全件の数 */
	gapCount: number;
};

export type StartImportResult =
	| { ok: true; job: ImportJob }
	| { ok: false; reason: "busy"; job: ImportJob };

export interface MarketDataService {
	startImport(input: {
		text: string;
		timeframe: Timeframe;
		fileName: string;
	}): StartImportResult;
	getImport(id: number): ImportJob | null;
	cancelImport(id: number): ImportJob | null;
	/** 重なりの確認に答える。確認を待っていなければ ok: false */
	resolveImport(
		id: number,
		overwrite: boolean,
	): { ok: true; job: ImportJob } | { ok: false; job: ImportJob | null };
	listImports(): ImportJob[];
	coverage(): TimeframeCoverage[];
	/** 期間のバックテストで使える粒度（細かい順）。期間の一部にしか無い粒度は除く */
	usableTimeframes(from: number, to: number): Timeframe[];
	/**
	 * 期間 [from, to) の足を古い順に書き出す。作りかけの自動で作った足は除く。足が無ければ null。
	 * pages は1回の読み込みごとに足の配列を返す（大きな期間でもメモリに載せきらない）
	 */
	exportCandles(
		timeframe: Timeframe,
		from: number,
		to: number,
	): { first: number; last: number; pages: Iterable<Candle[]> } | null;
	/** 最後に確定した足の終値（time は足の終わりの時刻） */
	latestClose(): { time: number; close: number } | null;
}
