// データセットの API が使う型。app.ts から参照されるため、Bun 固有の型を持ち込まない

import type {
	ConditionSet,
	DatasetSummary,
	FeeRates,
	ValidationError,
} from "@trading-studio/core";
import type {
	BacktestInput,
	BacktestRun,
	BacktestStatus,
	RunFilter,
	StartBacktestFailure,
} from "../backtests/types";
import type { Segment } from "../segments/types";

export type Dataset = {
	id: number;
	name: string;
	/** 残っている相場データ（新しい順） */
	segments: Segment[];
	/** 保存した後に消えた相場データの数 */
	missing: number;
	createdAt: number;
	updatedAt: number;
};

export type DatasetInput = { name: string; segmentIds: number[] };

export type SaveDatasetResult =
	| { ok: true; dataset: Dataset }
	| {
			ok: false;
			kind: "not_found" | "invalid" | "duplicate_name";
			message: string;
	  };

/** まとめて実行する条件。期間はデータセットの相場データで決める */
export type DatasetRunInput = Omit<
	BacktestInput,
	"from" | "to" | "segmentId"
> & {
	datasetId: number;
};

export type DatasetRun = {
	id: number;
	datasetId: number;
	/** 実行したときのデータセット名 */
	datasetName: string;
	/** バックテスト名 */
	name: string;
	params: ConditionSet;
	initialCash: number;
	fees: FeeRates;
	skipGaps: boolean;
	criteriaVersion: number | null;
	/** 実行する順の相場データ */
	segmentIds: number[];
	status: BacktestStatus;
	/** 全体の進み具合（0〜1） */
	progress: number;
	startedAt: number;
	finishedAt: number | null;
	/** 合算した成績。完了したときだけ入る */
	summary: DatasetSummary | null;
	error: string | null;
};

/** まとめた実行と、相場データごとの実行（実行した順） */
export type DatasetRunDetail = DatasetRun & { runs: BacktestRun[] };

/** 実行できない相場データと理由 */
export type DatasetBlocker = {
	segment: Segment;
	error: StartBacktestFailure;
};

export type StartDatasetResult =
	| { ok: true; run: DatasetRun }
	| { ok: false; error: StartDatasetFailure };

export type StartDatasetFailure =
	| { kind: "busy"; message: string }
	| { kind: "not_found"; message: string }
	| { kind: "empty"; message: string }
	| { kind: "invalid_params"; errors: ValidationError[] }
	| { kind: "invalid_input"; field: string; message: string }
	/** 実行できない相場データがある。一部だけ実行すると比べられないので、全体を実行しない */
	| { kind: "blocked"; blockers: DatasetBlocker[] };

/** 履歴に並べる1行。単独の実行か、まとめた実行 */
export type HistoryEntry =
	| { kind: "run"; run: BacktestRun }
	| { kind: "dataset"; datasetRun: DatasetRun };

export type HistoryResult = { entries: HistoryEntry[]; total: number };

export interface DatasetService {
	list(): Dataset[];
	get(id: number): Dataset | null;
	create(input: DatasetInput): SaveDatasetResult;
	update(id: number, input: DatasetInput): SaveDatasetResult;
	remove(id: number): boolean;
	start(input: DatasetRunInput): StartDatasetResult;
	run(id: number): DatasetRunDetail | null;
	/** 実行中のまとめた実行。無ければ null */
	current(): DatasetRun | null;
	cancel(id: number): DatasetRun | null;
	/** 単独の実行とまとめた実行を新しい順などで並べる。まとめた実行に含まれる実行は出さない */
	history(filter?: Partial<RunFilter>): HistoryResult;
}
