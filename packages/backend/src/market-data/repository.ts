// 足と取り込みの記録の読み書き

import type { Candle, CsvRowError, Gap, Timeframe } from "@trading-studio/core";
import {
	aggregateCandles,
	candleStart,
	findGaps,
	TIMEFRAME_MS,
	TIMEFRAMES,
} from "@trading-studio/core";
import type { Db } from "../db/open";
import type { ImportJob, ImportStatus, TimeframeCoverage } from "./types";

type ImportRow = {
	id: number;
	timeframe: Timeframe;
	file_name: string;
	status: ImportStatus;
	started_at: number;
	finished_at: number | null;
	total_rows: number;
	inserted_rows: number;
	skipped_rows: number;
	derived_rows: number;
	first_time: number | null;
	last_time: number | null;
	error: string | null;
};

function toJob(r: ImportRow): ImportJob {
	const err = r.error
		? (JSON.parse(r.error) as {
				message: string;
				errors: CsvRowError[];
				errorCount: number;
			})
		: null;
	return {
		id: r.id,
		timeframe: r.timeframe,
		fileName: r.file_name,
		status: r.status,
		phase: null,
		processedRows: r.status === "done" ? r.total_rows : 0,
		totalRows: r.total_rows,
		insertedRows: r.inserted_rows,
		skippedRows: r.skipped_rows,
		derivedRows: r.derived_rows,
		startedAt: r.started_at,
		finishedAt: r.finished_at,
		firstTime: r.first_time,
		lastTime: r.last_time,
		message: err?.message ?? null,
		errors: err?.errors ?? [],
		errorCount: err?.errorCount ?? 0,
	};
}

/** 画面に返す欠損の上限 */
const MAX_GAPS = 200;

export class MarketDataRepository {
	constructor(private readonly db: Db) {}

	private get sql() {
		return this.db.$client;
	}

	createImport(timeframe: Timeframe, fileName: string, now: number): number {
		const r = this.sql
			.query<{ id: number }, [string, string, number]>(
				"insert into data_imports (timeframe, file_name, status, started_at) values (?, ?, 'running', ?) returning id",
			)
			.get(timeframe, fileName, now);
		return (r as { id: number }).id;
	}

	finishImport(job: ImportJob): void {
		const error =
			job.message || job.errors.length
				? JSON.stringify({
						message: job.message,
						errors: job.errors,
						errorCount: job.errorCount,
					})
				: null;
		this.sql.run(
			`update data_imports set status = ?, finished_at = ?, total_rows = ?, inserted_rows = ?, skipped_rows = ?,
			 derived_rows = ?, first_time = ?, last_time = ?, error = ? where id = ?`,
			[
				job.status,
				job.finishedAt,
				job.totalRows,
				job.insertedRows,
				job.skippedRows,
				job.derivedRows,
				job.firstTime,
				job.lastTime,
				error,
				job.id,
			],
		);
	}

	/** サーバーが途中で止まった取り込みを失敗として残す */
	failInterrupted(now: number): number {
		return this.sql.run(
			`update data_imports set status = 'failed', finished_at = ?,
			 error = json_object('message', 'サーバーが途中で止まったため中断した', 'errors', json('[]'), 'errorCount', 0)
			 where status = 'running'`,
			[now],
		).changes;
	}

	getImport(id: number): ImportJob | null {
		const r = this.sql
			.query<ImportRow, [number]>("select * from data_imports where id = ?")
			.get(id);
		return r ? toJob(r) : null;
	}

	listImports(limit = 50): ImportJob[] {
		return this.sql
			.query<ImportRow, [number]>(
				"select * from data_imports order by id desc limit ?",
			)
			.all(limit)
			.map(toJob);
	}

	/**
	 * 取り込んだ足を保存する。同じ粒度・同じ日時に取り込んだ足があれば保存しない（件数に数える）。
	 * 自動で作った足しか無ければ、取り込んだ足で置き換える（直接取り込んだ足を優先する）
	 */
	insertImported(
		timeframe: Timeframe,
		rows: readonly Candle[],
		importId: number,
	): { inserted: number; skipped: number } {
		const stmt = this.sql.prepare(
			`insert into candles (timeframe, time, open, high, low, close, volume, source, import_id)
			 values (?, ?, ?, ?, ?, ?, ?, 'import', ?)
			 on conflict (timeframe, time) do update set
			   open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
			   volume = excluded.volume, source = 'import', import_id = excluded.import_id
			 where candles.source = 'derived'`,
		);
		let inserted = 0;
		this.sql.transaction(() => {
			for (const c of rows) {
				inserted += stmt.run(
					timeframe,
					c.time,
					c.open,
					c.high,
					c.low,
					c.close,
					c.volume,
					importId,
				).changes;
			}
		})();
		return { inserted, skipped: rows.length - inserted };
	}

	/** 取り込みを取り消す。その取り込みで保存した足を消す */
	deleteImported(importId: number): void {
		this.sql.run("delete from candles where import_id = ?", [importId]);
	}

	loadCandles(timeframe: Timeframe, from: number, to: number): Candle[] {
		return this.sql
			.query<Candle, [string, number, number]>(
				"select time, open, high, low, close, volume from candles where timeframe = ? and time >= ? and time < ? order by time",
			)
			.all(timeframe, from, to);
	}

	/**
	 * 期間 [from, to) の粗い粒度の足を、1段細かい粒度の足から作り直す（1分→5分→15分→1時間→4時間→日足）。
	 * 取り込んだ足は上書きせず、足が無い日時と自動で作った足だけを埋める。作った足の数を返す
	 */
	refillDerived(from: number, to: number, importId: number): number {
		const start = candleStart(from, "1d");
		const end = candleStart(to - 1, "1d") + TIMEFRAME_MS["1d"];
		const stmt = this.sql.prepare(
			`insert into candles (timeframe, time, open, high, low, close, volume, source, import_id)
			 values (?, ?, ?, ?, ?, ?, ?, 'derived', ?)
			 on conflict (timeframe, time) do update set
			   open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
			   volume = excluded.volume, import_id = excluded.import_id
			 where candles.source = 'derived'`,
		);
		let written = 0;
		for (let i = 1; i < TIMEFRAMES.length; i++) {
			const source = TIMEFRAMES[i - 1] as Timeframe;
			const target = TIMEFRAMES[i] as Timeframe;
			const derived = aggregateCandles(
				this.loadCandles(source, start, end),
				target,
			);
			this.sql.transaction(() => {
				for (const c of derived) {
					written += stmt.run(
						target,
						c.time,
						c.open,
						c.high,
						c.low,
						c.close,
						c.volume,
						importId,
					).changes;
				}
			})();
		}
		return written;
	}

	/** 取り込み済みの足のうち、最後に確定した足の終値。足が無ければ null */
	latestClose(): { time: number; close: number } | null {
		let best: { time: number; close: number } | null = null;
		for (const tf of TIMEFRAMES) {
			const r = this.sql
				.query<{ time: number; close: number }, [string]>(
					"select time, close from candles where timeframe = ? order by time desc limit 1",
				)
				.get(tf);
			if (r) {
				const end = r.time + TIMEFRAME_MS[tf];
				if (!best || end > best.time) best = { time: end, close: r.close };
			}
		}
		return best;
	}

	coverage(): TimeframeCoverage[] {
		return TIMEFRAMES.map((timeframe) => {
			const s = this.sql
				.query<
					{
						count: number;
						imported: number | null;
						first: number | null;
						last: number | null;
					},
					[string]
				>(
					"select count(*) as count, sum(source = 'import') as imported, min(time) as first, max(time) as last from candles where timeframe = ?",
				)
				.get(timeframe);
			const gaps = this.gaps(timeframe);
			return {
				timeframe,
				count: s?.count ?? 0,
				importedCount: s?.imported ?? 0,
				firstTime: s?.first ?? null,
				lastTime: s?.last ?? null,
				gaps: gaps.slice(0, MAX_GAPS),
				gapCount: gaps.length,
			};
		});
	}

	/** 欠損の区間。足の開始時刻の差が1本より長いところ */
	gaps(timeframe: Timeframe, from?: number, to?: number): Gap[] {
		const step = TIMEFRAME_MS[timeframe];
		const rows = this.sql
			.query<{ time: number; next: number }, [string, number, number, number]>(
				`select time, next from (
				   select time, lead(time) over (order by time) as next from candles
				   where timeframe = ? and time >= ? and time < ?
				 ) where next - time > ?`,
			)
			.all(
				timeframe,
				from ?? Number.MIN_SAFE_INTEGER,
				to ?? Number.MAX_SAFE_INTEGER,
				step,
			);
		return rows.flatMap((r) => findGaps([r.time, r.next], timeframe));
	}
}
