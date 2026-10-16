import type {
	ConditionSet,
	DatasetSummary,
	FeeRates,
} from "@trading-studio/core";
import type { RunFilter } from "../backtests/types-domain";
import type { DatasetRun, HistoryResult } from "./types-domain";

export interface DatasetRepository {
	list(): StoredDataset[];
	get(id: number): StoredDataset | null;
	nameTaken(name: string, exceptId: number | null): boolean;
	create(name: string, segmentIds: number[], now: number): number;
	update(id: number, name: string, segmentIds: number[], now: number): void;
	remove(id: number): boolean;
	createRun(run: {
		datasetId: number;
		datasetName: string;
		name: string;
		segmentIds: number[];
		input: StoredDatasetInput;
		startedAt: number;
	}): number;
	finishRun(
		id: number,
		status: "done" | "failed" | "canceled",
		summary: DatasetSummary | null,
		error: string | null,
		now: number,
	): void;
	/** サーバーが途中で止まったまとめた実行を失敗として残す */
	failInterrupted(now: number): number;
	getRun(id: number): DatasetRun | null;
	/** まとめた実行に含まれる実行の id（実行した順） */
	childIds(datasetRunId: number): number[];
	/** 単独の実行とまとめた実行を合わせて並べる。並びと絞り込みは RunFilter の意味に合わせる */
	history({ limit, q, hideFailed, sort }?: Partial<RunFilter>): HistoryResult;
}

export type StoredDataset = {
	id: number;
	name: string;
	segmentIds: number[];
	createdAt: number;
	updatedAt: number;
};

export type StoredDatasetInput = {
	params: ConditionSet;
	initialCash: number;
	fees: FeeRates;
	skipGaps: boolean;
	criteriaVersion: number | null;
	/** 足す前に保存した実行には無い */
	eventCriteriaVersion?: number | null;
};
