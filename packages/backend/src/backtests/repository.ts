// バックテストの実行と結果の読み書き

import { gunzipSync } from "node:zlib";
import type {
	BacktestOrder,
	BacktestSummary,
	ConditionSet,
	Timeframe,
} from "@trading-studio/core";
import { parseAggregationRule, parseConditionSet } from "@trading-studio/core";
import type { Db } from "../db/open";
import type { RunnerOutput } from "./runner";
import type { BacktestChart, BacktestRun, BacktestStatus } from "./types";

type RunRow = {
	id: number;
	strategy_id: number | null;
	strategy_name: string;
	current_name: string | null;
	params: string;
	timeframe: Timeframe;
	from_time: number;
	to_time: number;
	initial_cash: number;
	fee_limit_ppm: number;
	fee_market_ppm: number;
	skip_gaps: number;
	status: BacktestStatus;
	started_at: number;
	finished_at: number | null;
	bar_count: number;
	step_timeframe: Timeframe | null;
	step_limited: number;
	summary: string | null;
	filled_count: number;
	order_count: number;
	error: string | null;
	aggregation_rule: string | null;
};

function toRun(r: RunRow): BacktestRun {
	return {
		id: r.id,
		strategyId: r.strategy_id,
		strategyName: r.current_name ?? r.strategy_name,
		strategyExists: r.current_name !== null,
		// 保存するときに形を検証しているので、読み出しでは形が崩れていない前提で読む
		params: parseConditionSet(JSON.parse(r.params)) as ConditionSet,
		timeframe: r.timeframe,
		from: r.from_time,
		to: r.to_time,
		initialCash: r.initial_cash,
		fees: { limitPpm: r.fee_limit_ppm, marketPpm: r.fee_market_ppm },
		skipGaps: r.skip_gaps === 1,
		stepTimeframe: r.step_timeframe ?? r.timeframe,
		stepLimited: r.step_limited === 1,
		status: r.status,
		progress: r.status === "done" ? 1 : 0,
		startedAt: r.started_at,
		finishedAt: r.finished_at,
		barCount: r.bar_count,
		summary: r.summary ? (JSON.parse(r.summary) as BacktestSummary) : null,
		filledCount: r.filled_count,
		orderCount: r.order_count,
		error: r.error,
		aggregationRule: r.aggregation_rule
			? parseAggregationRule(JSON.parse(r.aggregation_rule))
			: null,
	};
}

const SELECT_RUN = `select r.*, s.name as current_name from backtest_runs r
	left join strategies s on s.id = r.strategy_id`;

const unpack = <T>(b: Uint8Array): T =>
	JSON.parse(new TextDecoder().decode(gunzipSync(b))) as T;

export class BacktestRepository {
	constructor(private readonly db: Db) {}

	private get sql() {
		return this.db.$client;
	}

	create(
		run: Omit<
			BacktestRun,
			| "id"
			| "strategyName"
			| "strategyExists"
			| "status"
			| "progress"
			| "finishedAt"
			| "summary"
			| "filledCount"
			| "orderCount"
			| "error"
		> & { strategyName: string },
	): number {
		return Number(
			this.sql.run(
				`insert into backtest_runs (strategy_id, strategy_name, params, timeframe, from_time, to_time,
				 initial_cash, fee_limit_ppm, fee_market_ppm, skip_gaps, status, started_at, bar_count,
				 step_timeframe, step_limited, aggregation_rule)
				 values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
				[
					run.strategyId,
					run.strategyName,
					JSON.stringify(run.params),
					run.timeframe,
					run.from,
					run.to,
					run.initialCash,
					run.fees.limitPpm,
					run.fees.marketPpm,
					run.skipGaps ? 1 : 0,
					run.startedAt,
					run.barCount,
					run.stepTimeframe,
					run.stepLimited ? 1 : 0,
					run.aggregationRule === null
						? null
						: JSON.stringify(run.aggregationRule),
				],
			).lastInsertRowid,
		);
	}

	finishDone(id: number, out: RunnerOutput, now: number): void {
		this.db.$client.transaction(() => {
			this.sql.run(
				`update backtest_runs set status = 'done', finished_at = ?, summary = ?,
				 filled_count = ?, order_count = ? where id = ?`,
				[now, JSON.stringify(out.summary), out.filledCount, out.orderCount, id],
			);
			this.sql.run(
				"insert into backtest_results (run_id, bars, orders, trades, decisions) values (?, ?, ?, ?, ?)",
				[id, out.bars, out.orders, out.trades, out.decisions],
			);
		})();
	}

	finishOther(
		id: number,
		status: "failed" | "canceled",
		error: string | null,
		now: number,
	): void {
		this.sql.run(
			"update backtest_runs set status = ?, finished_at = ?, error = ? where id = ?",
			[status, now, error, id],
		);
	}

	/** サーバーが途中で止まった実行を失敗として残す */
	failInterrupted(now: number): number {
		return this.sql.run(
			"update backtest_runs set status = 'failed', finished_at = ?, error = 'サーバーが途中で止まったため中断した' where status = 'running'",
			[now],
		).changes;
	}

	get(id: number): BacktestRun | null {
		const r = this.sql
			.query<RunRow, [number]>(`${SELECT_RUN} where r.id = ?`)
			.get(id);
		return r ? toRun(r) : null;
	}

	list(limit = 100): BacktestRun[] {
		return this.sql
			.query<RunRow, [number]>(`${SELECT_RUN} order by r.id desc limit ?`)
			.all(limit)
			.map(toRun);
	}

	setStrategy(id: number, strategyId: number): void {
		this.sql.run("update backtest_runs set strategy_id = ? where id = ?", [
			strategyId,
			id,
		]);
	}

	private blob(id: number, column: "bars" | "orders"): Uint8Array | null {
		const r = this.sql
			.query<{ v: Uint8Array }, [number]>(
				`select ${column} as v from backtest_results where run_id = ?`,
			)
			.get(id);
		return r?.v ?? null;
	}

	chart(id: number): Omit<BacktestChart, "judgments"> | null {
		const bars = this.blob(id, "bars");
		const orders = this.orders(id);
		if (!bars || !orders) return null;
		const b = unpack<{ times: number[]; closes: number[] }>(bars);
		const closeAt = (t: number) => {
			const i = b.times.findLastIndex((x) => x <= t);
			return b.closes[Math.max(0, i)] as number;
		};
		return {
			bars: b.times.map((time, i) => ({ time, close: b.closes[i] as number })),
			markers: orders.map((o) => {
				const time =
					o.status === "filled"
						? (o.filledAt as number)
						: o.status === "canceled"
							? (o.canceledAt as number)
							: o.placedAt;
				// 成行の注文中は価格が無いので、そのときの終値に置く
				const price = o.fillPrice ?? o.price ?? closeAt(time);
				return { id: o.id, side: o.side, status: o.status, time, price };
			}),
		};
	}

	orders(id: number): BacktestOrder[] | null {
		const b = this.blob(id, "orders");
		return b ? unpack<BacktestOrder[]>(b) : null;
	}
}
