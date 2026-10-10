// データセットの保存と、まとめた実行。相場データごとに通常のバックテストを1件ずつ順に実行し、終わったら成績を合算する

import type { DatasetMember } from "@trading-studio/core";
import {
	MAX_DATASET_SEGMENTS,
	summarizeDataset,
	validateConditionSet,
} from "@trading-studio/core";
import type { BacktestRepository } from "../backtests/repository";
import type {
	BacktestRun,
	BacktestService,
	StartBacktestFailure,
} from "../backtests/types";
import type { Segment, SegmentService } from "../segments/types";
import { checkName } from "../strategies/service";
import type { DatasetRepository, StoredDataset } from "./repository";
import type {
	Dataset,
	DatasetBlocker,
	DatasetInput,
	DatasetRun,
	DatasetService,
	SaveDatasetResult,
	StartDatasetFailure,
	StartDatasetResult,
} from "./types";

export type DatasetServiceDeps = {
	repo: DatasetRepository;
	backtestRepo: BacktestRepository;
	backtests: BacktestService;
	segments: Pick<SegmentService, "get">;
	now?: () => number;
};

const fail = (error: StartDatasetFailure): StartDatasetResult => ({
	ok: false,
	error,
});

/** 相場データに依らない誤り。相場データごとに並べず、そのまま返す */
function commonError(e: StartBacktestFailure): StartDatasetFailure | null {
	switch (e.kind) {
		case "busy":
			return {
				kind: "busy",
				message: "別のバックテストを実行中。終わるか中止してから実行する",
			};
		case "invalid_params":
		case "invalid_input":
			return e;
		default:
			return null;
	}
}

export function createDatasetService({
	repo,
	backtestRepo,
	backtests,
	segments,
	now = Date.now,
}: DatasetServiceDeps): DatasetService & { running(): Promise<void> | null } {
	/** 実行中のまとめた実行。index は実行中の相場データの位置 */
	let current: {
		id: number;
		index: number;
		childId: number | null;
		cancelRequested: boolean;
		done: Promise<void>;
		resolve: () => void;
	} | null = null;

	const existing = (ids: readonly number[]): Segment[] =>
		ids.flatMap((id) => {
			const d = segments.get(id);
			return d ? [d] : [];
		});

	const view = (s: StoredDataset): Dataset => {
		const list = existing(s.segmentIds).sort((a, b) => b.from - a.from);
		return {
			id: s.id,
			name: s.name,
			segments: list,
			missing: s.segmentIds.length - list.length,
			createdAt: s.createdAt,
			updatedAt: s.updatedAt,
		};
	};

	function checkDataset(
		input: DatasetInput,
		exceptId: number | null,
	): { name: string; ids: number[] } | SaveDatasetResult {
		const nameError = checkName(input.name);
		if (nameError) return { ok: false, kind: "invalid", message: nameError };
		const name = input.name.trim();
		if (repo.nameTaken(name, exceptId)) {
			return {
				ok: false,
				kind: "duplicate_name",
				message: "同じ名前のデータセットがある",
			};
		}
		const ids = [...new Set(input.segmentIds)];
		if (ids.length === 0) {
			return { ok: false, kind: "invalid", message: "相場データを選ぶ" };
		}
		if (ids.length > MAX_DATASET_SEGMENTS) {
			return {
				ok: false,
				kind: "invalid",
				message: `相場データは ${MAX_DATASET_SEGMENTS} 件までにする`,
			};
		}
		if (existing(ids).length !== ids.length) {
			return {
				ok: false,
				kind: "invalid",
				message: "見つからない相場データがある。選び直す",
			};
		}
		return { name, ids };
	}

	const withProgress = (run: DatasetRun): DatasetRun => {
		if (current?.id !== run.id || run.status !== "running") return run;
		const child =
			current.childId === null ? null : backtests.get(current.childId);
		const part = child?.status === "running" ? child.progress : 0;
		return {
			...run,
			progress: (current.index + part) / run.segmentIds.length,
		};
	};

	const getRun = (id: number) => {
		const r = repo.getRun(id);
		return r ? withProgress(r) : null;
	};

	function finish(
		status: "done" | "failed" | "canceled",
		error: string | null,
	) {
		if (!current) return;
		const { id, resolve } = current;
		let summary = null;
		if (status === "done") {
			const members: DatasetMember[] = repo.childIds(id).flatMap((childId) => {
				const run = backtestRepo.get(childId);
				const trades = backtestRepo.trades(childId);
				if (!run?.summary || !run.segment || !trades) return [];
				return [
					{
						regime: run.segment.regime,
						summary: run.summary,
						tradePnls: trades.map((t) => t.pnl),
					},
				];
			});
			summary = summarizeDataset(members);
		}
		repo.finishRun(id, status, summary, error, now());
		current = null;
		resolve();
	}

	function runNext() {
		if (!current) return;
		const run = repo.getRun(current.id);
		if (!run) return finish("failed", "まとめた実行が見つからない");
		if (current.cancelRequested) return finish("canceled", null);
		const segmentId = run.segmentIds[current.index];
		if (segmentId === undefined) return finish("done", null);
		let started: ReturnType<BacktestService["start"]>;
		try {
			started = backtests.start(
				{
					name: run.name,
					params: run.params,
					from: 0,
					to: 0,
					initialCash: run.initialCash,
					fees: run.fees,
					skipGaps: run.skipGaps,
					criteriaVersion: run.criteriaVersion,
					segmentId,
				},
				{
					datasetRunId: run.id,
					// 終わった実行の後始末が済んでから次を始める
					onFinish: (child) => queueMicrotask(() => afterChild(child)),
				},
			);
		} catch (e) {
			// 例外のまま抜けると current が残り、以後ずっと busy になる
			return finish("failed", e instanceof Error ? e.message : String(e));
		}
		if (!started.ok) {
			const d = segments.get(segmentId);
			const e = started.error;
			const reason =
				"message" in e ? e.message : "実行の前の検証を通らなかった";
			return finish(
				"failed",
				`${d ? segmentLabel(d) : `相場データ ${segmentId}`} を実行できなかった: ${reason}`,
			);
		}
		current.childId = started.run.id;
	}

	function afterChild(child: BacktestRun) {
		if (!current || child.datasetRunId !== current.id) return;
		if (child.status === "canceled" || current.cancelRequested) {
			return finish("canceled", null);
		}
		if (child.status === "failed") {
			const d = child.segment && segments.get(child.segment.id);
			return finish(
				"failed",
				`${d ? segmentLabel(d) : "相場データ"} で失敗した: ${child.error ?? "原因不明"}`,
			);
		}
		current.index++;
		current.childId = null;
		runNext();
	}

	return {
		list: () => repo.list().map(view),

		get(id) {
			const s = repo.get(id);
			return s ? view(s) : null;
		},

		create(input) {
			const c = checkDataset(input, null);
			if ("ok" in c) return c;
			const id = repo.create(c.name, c.ids, now());
			return { ok: true, dataset: view(repo.get(id) as StoredDataset) };
		},

		update(id, input) {
			if (!repo.get(id)) {
				return {
					ok: false,
					kind: "not_found",
					message: "データセットが見つからない",
				};
			}
			const c = checkDataset(input, id);
			if ("ok" in c) return c;
			repo.update(id, c.name, c.ids, now());
			return { ok: true, dataset: view(repo.get(id) as StoredDataset) };
		},

		remove: (id) => repo.remove(id),

		start(input) {
			if (current || backtests.current()) {
				return fail({
					kind: "busy",
					message: "別のバックテストを実行中。終わるか中止してから実行する",
				});
			}
			const dataset = repo.get(input.datasetId);
			if (!dataset) {
				return fail({
					kind: "not_found",
					message: "データセットが見つからない",
				});
			}
			// 古い順に実行する
			const list = existing(dataset.segmentIds).sort((a, b) => a.from - b.from);
			if (list.length === 0) {
				return fail({
					kind: "empty",
					message:
						"データセットの相場データがすべて消えている。相場データを選び直す",
				});
			}
			const errors = validateConditionSet(input.params);
			if (errors.length > 0) return fail({ kind: "invalid_params", errors });
			// 一部だけ実行すると、組ごとに成績を比べられなくなるので、実行できない相場データがあれば全体を実行しない
			const blockers: DatasetBlocker[] = [];
			for (const segment of list) {
				const error = backtests.check({
					...input,
					from: 0,
					to: 0,
					segmentId: segment.id,
				});
				if (!error) continue;
				const common = commonError(error);
				if (common) return fail(common);
				blockers.push({ segment, error });
			}
			if (blockers.length > 0) return fail({ kind: "blocked", blockers });

			const id = repo.createRun({
				datasetId: dataset.id,
				datasetName: dataset.name,
				name: input.name.trim(),
				segmentIds: list.map((d) => d.id),
				input: {
					params: input.params,
					initialCash: input.initialCash,
					fees: input.fees,
					skipGaps: input.skipGaps,
					criteriaVersion: input.criteriaVersion,
				},
				startedAt: now(),
			});
			let resolve = () => {};
			const done = new Promise<void>((r) => {
				resolve = r;
			});
			current = {
				id,
				index: 0,
				childId: null,
				cancelRequested: false,
				done,
				resolve,
			};
			runNext();
			return { ok: true, run: getRun(id) as DatasetRun };
		},

		run(id) {
			const r = getRun(id);
			if (!r) return null;
			return {
				...r,
				runs: repo
					.childIds(id)
					.flatMap((childId) => backtests.get(childId) ?? []),
			};
		},

		current() {
			return current ? getRun(current.id) : null;
		},

		cancel(id) {
			if (current?.id === id) {
				current.cancelRequested = true;
				if (current.childId !== null) backtests.cancel(current.childId);
			}
			return getRun(id);
		},

		history: (filter) => repo.history(filter),

		running() {
			return current?.done ?? null;
		},
	};
}

/** 例: 2026/08〜09 上昇相場。サーバーのメッセージ用（JST） */
function segmentLabel(d: Segment): string {
	const ym = (t: number) => {
		const j = new Date(t + 9 * 3_600_000);
		return `${j.getUTCFullYear()}/${String(j.getUTCMonth() + 1).padStart(2, "0")}`;
	};
	const a = ym(d.from);
	const b = ym(d.to - 1);
	const regime = {
		up: "上昇",
		down: "下落",
		range: "レンジ",
		volatile: "乱高下",
	}[d.regime];
	return `${a}〜${a.slice(0, 4) === b.slice(0, 4) ? b.slice(5) : b} ${regime}相場`;
}
