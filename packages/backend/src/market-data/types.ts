// 過去データの API が使う型。app.ts から参照されるため、Bun 固有の型を持ち込まない

import type { CsvRowError, Gap, Timeframe } from "@trading-studio/core";

export type ImportStatus = "running" | "done" | "failed" | "canceled";
/** validating: 検証中 / saving: 保存中 / deriving: 粗い粒度の足を作成中 */
export type ImportPhase = "validating" | "saving" | "deriving";

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
	/** 失敗の理由 */
	message: string | null;
	errors: CsvRowError[];
	errorCount: number;
};

export type TimeframeCoverage = {
	timeframe: Timeframe;
	count: number;
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
	listImports(): ImportJob[];
	coverage(): TimeframeCoverage[];
}
