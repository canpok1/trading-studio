// データセットとまとめた実行の読み書き

import type {
	ConditionSet,
	DatasetSummary,
	FeeRates,
} from "@trading-studio/core";
import { parseConditionSet } from "@trading-studio/core";
import type { BacktestRepository } from "../backtests/repository";
import type { BacktestStatus, RunFilter } from "../backtests/types";
import type { Db } from "../db/open";
import type { DatasetRun, HistoryEntry, HistoryResult } from "./types";

type DatasetRow = {
	id: number;
	name: string;
	segment_ids: string;
	created_at: number;
	updated_at: number;
};

export type StoredDataset = {
	id: number;
	name: string;
	segmentIds: number[];
	createdAt: number;
	updatedAt: number;
};

const toDataset = (r: DatasetRow): StoredDataset => ({
	id: r.id,
	name: r.name,
	segmentIds: JSON.parse(r.segment_ids) as number[],
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

/** まとめた実行の条件。相場データごとの実行を始めるのに使う */
export type StoredDatasetInput = {
	params: ConditionSet;
	initialCash: number;
	fees: FeeRates;
	skipGaps: boolean;
	criteriaVersion: number | null;
};

type RunRow = {
	id: number;
	dataset_id: number;
	dataset_name: string;
	name: string;
	segment_ids: string;
	input: string;
	status: BacktestStatus;
	started_at: number;
	finished_at: number | null;
	summary: string | null;
	error: string | null;
};

function toRun(r: RunRow): DatasetRun {
	const input = JSON.parse(r.input) as StoredDatasetInput;
	return {
		id: r.id,
		datasetId: r.dataset_id,
		datasetName: r.dataset_name,
		name: r.name,
		// 保存するときに形を検証しているので、読み出しでは形が崩れていない前提で読む
		params: parseConditionSet(input.params) as ConditionSet,
		initialCash: input.initialCash,
		fees: input.fees,
		skipGaps: input.skipGaps,
		criteriaVersion: input.criteriaVersion,
		segmentIds: JSON.parse(r.segment_ids) as number[],
		status: r.status,
		progress: r.status === "done" ? 1 : 0,
		startedAt: r.started_at,
		finishedAt: r.finished_at,
		summary: r.summary ? (JSON.parse(r.summary) as DatasetSummary) : null,
		error: r.error,
	};
}

export class DatasetRepository {
	constructor(
		private readonly db: Db,
		private readonly backtests: BacktestRepository,
	) {}

	private get sql() {
		return this.db.$client;
	}

	list(): StoredDataset[] {
		return this.sql
			.query<DatasetRow, []>("select * from datasets order by name")
			.all()
			.map(toDataset);
	}

	get(id: number): StoredDataset | null {
		const r = this.sql
			.query<DatasetRow, [number]>("select * from datasets where id = ?")
			.get(id);
		return r ? toDataset(r) : null;
	}

	nameTaken(name: string, exceptId: number | null): boolean {
		return (
			this.sql
				.query<{ id: number }, [string, number]>(
					"select id from datasets where name = ? and id != ?",
				)
				.get(name, exceptId ?? -1) !== null
		);
	}

	create(name: string, segmentIds: number[], now: number): number {
		return Number(
			this.sql.run(
				"insert into datasets (name, segment_ids, created_at, updated_at) values (?, ?, ?, ?)",
				[name, JSON.stringify(segmentIds), now, now],
			).lastInsertRowid,
		);
	}

	update(id: number, name: string, segmentIds: number[], now: number): void {
		this.sql.run(
			"update datasets set name = ?, segment_ids = ?, updated_at = ? where id = ?",
			[name, JSON.stringify(segmentIds), now, id],
		);
	}

	remove(id: number): boolean {
		return this.sql.run("delete from datasets where id = ?", [id]).changes > 0;
	}

	createRun(run: {
		datasetId: number;
		datasetName: string;
		name: string;
		segmentIds: number[];
		input: StoredDatasetInput;
		startedAt: number;
	}): number {
		return Number(
			this.sql.run(
				`insert into dataset_runs (dataset_id, dataset_name, name, segment_ids, input, status, started_at)
				 values (?, ?, ?, ?, ?, 'running', ?)`,
				[
					run.datasetId,
					run.datasetName,
					run.name,
					JSON.stringify(run.segmentIds),
					JSON.stringify(run.input),
					run.startedAt,
				],
			).lastInsertRowid,
		);
	}

	finishRun(
		id: number,
		status: "done" | "failed" | "canceled",
		summary: DatasetSummary | null,
		error: string | null,
		now: number,
	): void {
		this.sql.run(
			"update dataset_runs set status = ?, finished_at = ?, summary = ?, error = ? where id = ?",
			[
				status,
				now,
				summary === null ? null : JSON.stringify(summary),
				error,
				id,
			],
		);
	}

	/** サーバーが途中で止まったまとめた実行を失敗として残す */
	failInterrupted(now: number): number {
		return this.sql.run(
			"update dataset_runs set status = 'failed', finished_at = ?, error = 'サーバーが途中で止まったため中断した' where status = 'running'",
			[now],
		).changes;
	}

	getRun(id: number): DatasetRun | null {
		const r = this.sql
			.query<RunRow, [number]>("select * from dataset_runs where id = ?")
			.get(id);
		return r ? toRun(r) : null;
	}

	/** まとめた実行に含まれる実行の id（実行した順） */
	childIds(datasetRunId: number): number[] {
		return this.sql
			.query<{ id: number }, [number]>(
				"select id from backtest_runs where dataset_run_id = ? order by id",
			)
			.all(datasetRunId)
			.map((r) => r.id);
	}

	/** 単独の実行とまとめた実行を合わせて並べる。並びと絞り込みは RunFilter の意味に合わせる */
	history({
		limit = 100,
		q = "",
		hideFailed = false,
		sort = "new",
	}: Partial<RunFilter> = {}): HistoryResult {
		const where: string[] = [];
		const args: (string | number)[] = [];
		for (const word of q.split(/\s+/).filter(Boolean)) {
			where.push("e.name like ? escape '\\'");
			args.push(`%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
		}
		if (hideFailed) where.push("e.status not in ('failed', 'canceled')");
		const cond = where.length ? ` where ${where.join(" and ")}` : "";
		// まとめた実行の損益は、相場データごとの損益率の平均で並べる
		const entries = `(
			select 'run' as kind, r.id, r.strategy_name as name, r.status, r.started_at,
				json_extract(r.summary, '$.pnlPercent') as pnl
			from backtest_runs r where r.dataset_run_id is null
			union all
			select 'dataset' as kind, s.id, s.name, s.status, s.started_at,
				json_extract(s.summary, '$.averagePnlPercent') as pnl
			from dataset_runs s
		) e`;
		const order =
			sort === "pnl"
				? "e.pnl is null, e.pnl desc, e.started_at desc, e.id desc"
				: "e.started_at desc, e.id desc";
		const total =
			this.sql
				.query<{ c: number }, (string | number)[]>(
					`select count(*) as c from ${entries}${cond}`,
				)
				.get(...args)?.c ?? 0;
		const rows = this.sql
			.query<{ kind: "run" | "dataset"; id: number }, (string | number)[]>(
				`select e.kind, e.id from ${entries}${cond} order by ${order} limit ?`,
			)
			.all(...args, limit);
		return {
			entries: rows.flatMap((r): HistoryEntry[] => {
				if (r.kind === "run") {
					const run = this.backtests.get(r.id);
					return run ? [{ kind: "run", run }] : [];
				}
				const datasetRun = this.getRun(r.id);
				return datasetRun ? [{ kind: "dataset", datasetRun }] : [];
			}),
			total,
		};
	}
}
