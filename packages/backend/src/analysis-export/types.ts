// 分析用エクスポートの API が使う型。app.ts から参照されるため、Bun 固有の型を持ち込まない

import type { BacktestRun } from "../backtests/types";

export type AnalysisExportInput = {
	/** 期間 [from, to) */
	from: number;
	to: number;
	/** 入れるバックテストの実行 */
	backtestIds: number[];
};

export type AnalysisExportResult =
	| { ok: true; fileName: string; data: Uint8Array }
	| { ok: false; message: string };

export interface AnalysisExportService {
	/** 開始時刻が [from, to) の完了したバックテスト（ZIP に入れるものを選ぶ一覧） */
	backtestRuns(from: number, to: number): BacktestRun[];
	build(input: AnalysisExportInput): AnalysisExportResult;
}
