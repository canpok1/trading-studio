// 過去データの取り込みジョブ。同時に動かすのは1つだけで、画面は進捗を定期的に問い合わせる

import type { Candle } from "@trading-studio/core";
import { parseCandleCsv } from "@trading-studio/core";
import type { MarketDataRepository } from "./repository";
import type {
	ImportJob,
	MarketDataService,
	StartImportResult,
	TimeframeCoverage,
} from "./types";

/** 1回のトランザクションで保存する行数。この単位で API の応答と中止の受け付けを挟む */
const CHUNK = 5000;

const yieldToEventLoop = () => new Promise((r) => setTimeout(r, 0));

export type MarketDataServiceOptions = {
	now?: () => number;
	/** テストで取り込みの完了を待つために使う */
	onSettled?: (job: ImportJob) => void;
};

export function createMarketDataService(
	repo: MarketDataRepository,
	{ now = Date.now, onSettled }: MarketDataServiceOptions = {},
): MarketDataService & { running(): Promise<void> | null } {
	type Entry = {
		job: ImportJob;
		cancel: boolean;
		done: Promise<void>;
		/** 重なりの確認を待っている間だけある。答え（上書きするか・中止か）を渡す */
		answer: ((choice: "overwrite" | "skip" | "cancel") => void) | null;
	};
	let current: Entry | null = null;

	const snapshot = (job: ImportJob): ImportJob => ({ ...job });

	async function run(entry: Entry, text: string): Promise<void> {
		const { job } = entry;
		const finish = (status: ImportJob["status"], message: string | null) => {
			job.status = status;
			job.phase = null;
			job.message = message;
			job.finishedAt = now();
			repo.finishImport(job);
			onSettled?.(snapshot(job));
		};
		try {
			job.phase = "validating";
			await yieldToEventLoop();
			const parsed = parseCandleCsv(text, job.timeframe, (done, total) => {
				job.processedRows = done;
				job.totalRows = total;
			});
			job.totalRows = parsed.totalRows;
			if (!parsed.ok) {
				job.errors = parsed.errors;
				job.errorCount = parsed.errorCount;
				finish("failed", "CSV に不正な行がある。1行も保存していない");
				return;
			}
			if (entry.cancel) {
				finish("canceled", null);
				return;
			}
			const candles = parsed.candles;
			job.skippedRows = parsed.duplicateRows;
			job.firstTime = candles[0]?.time ?? null;
			job.lastTime = candles.at(-1)?.time ?? null;

			// 既存の足と重なれば、上書きするかを利用者が選ぶまで保存しない
			job.overlap = repo.overlap(job.timeframe, candles);
			if (job.overlap) {
				job.phase = "confirming";
				const choice = await new Promise<"overwrite" | "skip" | "cancel">(
					(resolve) => {
						entry.answer = resolve;
					},
				);
				entry.answer = null;
				if (choice === "cancel") {
					finish("canceled", null);
					return;
				}
				job.overwrite = choice === "overwrite";
			}

			job.phase = "saving";
			job.processedRows = 0;
			job.totalRows = candles.length;
			for (let i = 0; i < candles.length; i += CHUNK) {
				await yieldToEventLoop();
				if (entry.cancel) {
					repo.deleteImported(job.id);
					// 取り込んだ足で置き換えた自動生成の足を作り直す
					repo.refillDerived(
						job.firstTime as number,
						(job.lastTime as number) + 1,
						job.id,
					);
					job.insertedRows = 0;
					finish("canceled", null);
					return;
				}
				const chunk: Candle[] = candles.slice(i, i + CHUNK);
				const r = repo.insertImported(job.timeframe, chunk, job.id, {
					overwrite: job.overwrite === true,
				});
				job.insertedRows += r.inserted;
				job.skippedRows += r.skipped;
				job.processedRows = Math.min(i + CHUNK, candles.length);
			}

			// ここから先は中止を受け付けない（保存済みの足と整合した粗い足を作り切るため）
			job.phase = "deriving";
			await yieldToEventLoop();
			job.derivedRows = repo.refillDerived(
				job.firstTime as number,
				(job.lastTime as number) + 1,
				job.id,
			);
			finish("done", null);
		} catch (e) {
			console.error("import failed", e);
			finish(
				"failed",
				`取り込み中にエラーが起きた: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	return {
		startImport({ text, timeframe, fileName }): StartImportResult {
			if (current && current.job.status === "running") {
				return { ok: false, reason: "busy", job: snapshot(current.job) };
			}
			const startedAt = now();
			const id = repo.createImport(timeframe, fileName, startedAt);
			const job: ImportJob = {
				id,
				timeframe,
				fileName,
				status: "running",
				phase: "validating",
				processedRows: 0,
				totalRows: 0,
				overlap: null,
				overwrite: null,
				insertedRows: 0,
				skippedRows: 0,
				derivedRows: 0,
				startedAt,
				finishedAt: null,
				firstTime: null,
				lastTime: null,
				message: null,
				errors: [],
				errorCount: 0,
			};
			const entry: Entry = {
				job,
				cancel: false,
				done: Promise.resolve(),
				answer: null,
			};
			// BOM 付きの UTF-8 でも読めるようにする
			entry.done = run(entry, text.replace(/^﻿/, ""));
			current = entry;
			return { ok: true, job: snapshot(job) };
		},

		getImport(id) {
			if (current?.job.id === id) return snapshot(current.job);
			return repo.getImport(id);
		},

		cancelImport(id) {
			if (current?.job.id === id && current.job.status === "running") {
				const { job } = current;
				// 上書きの保存を始めたら中止しない。上書きした足は元に戻せないため
				const saving = job.phase === "saving" && job.overwrite === true;
				if (current.answer) current.answer("cancel");
				else if (job.phase !== "deriving" && !saving) current.cancel = true;
				return snapshot(job);
			}
			return repo.getImport(id);
		},

		resolveImport(id, overwrite) {
			if (current?.job.id === id && current.answer) {
				// 保存は次のイベントループで始まるので、応答の時点で段階を進めておく
				// （確認待ちのまま返すと、画面が確認の表示を出し続けて二重に押せてしまう）
				current.job.phase = "saving";
				current.job.overwrite = overwrite;
				current.answer(overwrite ? "overwrite" : "skip");
				return { ok: true, job: snapshot(current.job) };
			}
			return {
				ok: false,
				job:
					current?.job.id === id ? snapshot(current.job) : repo.getImport(id),
			};
		},

		listImports() {
			const list = repo.listImports();
			return current
				? list.map((j) =>
						j.id === current?.job.id ? snapshot(current.job) : j,
					)
				: list;
		},

		usableTimeframes: (from, to) => repo.importedTimeframes(from, to),
		coverage(): TimeframeCoverage[] {
			return repo.coverage();
		},

		latestClose() {
			return repo.latestClose();
		},

		running() {
			return current && current.job.status === "running" ? current.done : null;
		},
	};
}
