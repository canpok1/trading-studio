// バックテストの実行と結果の読み書き

import { gunzipSync } from "node:zlib";
import type {
	BacktestOrder,
	BacktestSummary,
	ConditionSet,
	DecisionLog,
	MarketRegime,
	Timeframe,
	Trade,
} from "@trading-studio/core";
import { parseAggregationRule, parseConditionSet } from "@trading-studio/core";
import type { Db } from "../db/open";
import type { RunnerOutput } from "./runner";
import type {
	BacktestChart,
	BacktestRun,
	BacktestStatus,
	RunFilter,
	RunListResult,
} from "./types";

type RunRow = {
	id: number;
	strategy_name: string;
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
	criteria_version: number | null;
	news_delay_ms: number | null;
	news_data_version: number | null;
	dataset_id: number | null;
	dataset_regime: MarketRegime | null;
};

function toRun(r: RunRow): BacktestRun {
	return {
		id: r.id,
		name: r.strategy_name,
		// 保存するときに形を検証しているので、読み出しでは形が崩れていない前提で読む
		params: parseConditionSet(JSON.parse(r.params)) as ConditionSet,
		dailyLossLimitApplied: "dailyLossLimit" in JSON.parse(r.params),
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
		criteriaVersion: r.criteria_version,
		newsDelayMs: r.news_delay_ms,
		newsDataVersion: r.news_data_version,
		dataset:
			r.dataset_id === null || r.dataset_regime === null
				? null
				: { id: r.dataset_id, regime: r.dataset_regime },
	};
}

const SELECT_RUN = "select r.* from backtest_runs r";

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
			| "status"
			| "progress"
			| "finishedAt"
			| "summary"
			| "filledCount"
			| "orderCount"
			| "error"
			| "dailyLossLimitApplied"
		>,
	): number {
		return Number(
			this.sql.run(
				`insert into backtest_runs (strategy_name, params, timeframe, from_time, to_time,
				 initial_cash, fee_limit_ppm, fee_market_ppm, skip_gaps, status, started_at, bar_count,
				 step_timeframe, step_limited, aggregation_rule, criteria_version, news_delay_ms, news_data_version,
				 dataset_id, dataset_regime)
				 values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					run.name,
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
					run.criteriaVersion,
					run.newsDelayMs,
					run.newsDataVersion,
					run.dataset?.id ?? null,
					run.dataset?.regime ?? null,
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

	list({
		limit = 100,
		q = "",
		hideFailed = false,
		sort = "new",
	}: Partial<RunFilter> = {}): RunListResult {
		const where: string[] = [];
		const args: (string | number)[] = [];
		for (const word of q.split(/\s+/).filter(Boolean)) {
			where.push("r.strategy_name like ? escape '\\'");
			args.push(`%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
		}
		if (hideFailed) where.push("r.status not in ('failed', 'canceled')");
		const cond = where.length ? ` where ${where.join(" and ")}` : "";
		const order =
			sort === "pnl"
				? "json_extract(r.summary, '$.pnlPercent') is null, json_extract(r.summary, '$.pnlPercent') desc, r.id desc"
				: "r.id desc";
		const total =
			this.sql
				.query<{ c: number }, (string | number)[]>(
					`select count(*) as c from backtest_runs r${cond}`,
				)
				.get(...args)?.c ?? 0;
		const runs = this.sql
			.query<RunRow, (string | number)[]>(
				`${SELECT_RUN}${cond} order by ${order} limit ?`,
			)
			.all(...args, limit)
			.map(toRun);
		return { runs, total };
	}

	/** 開始時刻が [from, to) の完了した実行（新しい順） */
	listDoneStartedBetween(from: number, to: number): BacktestRun[] {
		return this.sql
			.query<RunRow, [number, number]>(
				`${SELECT_RUN} where r.status = 'done' and r.started_at >= ? and r.started_at < ? order by r.id desc`,
			)
			.all(from, to)
			.map(toRun);
	}

	private blob(
		id: number,
		column: "bars" | "orders" | "trades" | "decisions",
	): Uint8Array | null {
		const r = this.sql
			.query<{ v: Uint8Array }, [number]>(
				`select ${column} as v from backtest_results where run_id = ?`,
			)
			.get(id);
		return r?.v ?? null;
	}

	chart(id: number): Omit<BacktestChart, "judgments"> | null {
		const run = this.get(id);
		const bars = this.blob(id, "bars");
		const orders = this.orders(id);
		if (!bars || !orders) return null;
		// opens・highs・lows は4本値を保存する前の実行には無い
		const b = unpack<{
			/** 残した足の粒度。持たない実行は戦略の足の粒度（run.timeframe） */
			timeframe?: Timeframe;
			times: number[];
			closes: number[];
			opens?: number[];
			highs?: number[];
			lows?: number[];
		}>(bars);
		const closeAt = (t: number) => {
			const i = b.times.findLastIndex((x) => x <= t);
			return b.closes[Math.max(0, i)] as number;
		};
		return {
			timeframe: b.timeframe ?? (run?.timeframe as Timeframe),
			bars: b.times.map((time, i) => {
				const close = b.closes[i] as number;
				if (!b.opens || !b.highs || !b.lows) return { time, close };
				return {
					time,
					open: b.opens[i] as number,
					high: b.highs[i] as number,
					low: b.lows[i] as number,
					close,
				};
			}),
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

	/** 結果の中身（注文・往復の取引・判断ログ）。結果が無ければ null */
	contents(id: number): {
		orders: BacktestOrder[];
		trades: Trade[];
		decisions: DecisionLog[];
	} | null {
		const orders = this.blob(id, "orders");
		const trades = this.blob(id, "trades");
		const decisions = this.blob(id, "decisions");
		if (!orders || !trades || !decisions) return null;
		return {
			orders: unpack<BacktestOrder[]>(orders),
			trades: unpack<Trade[]>(trades),
			decisions: unpack<DecisionLog[]>(decisions),
		};
	}
}
