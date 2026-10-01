// 自動取引の口座・注文・判断の記録・実行状態の読み書き

import type {
	DecisionLog,
	ExitKind,
	JsonValue,
	TradeOrder,
} from "@trading-studio/core";
import {
	inferExitKind,
	newAccount,
	normalizeAccount,
} from "@trading-studio/core";
import type { Db } from "../db/open";
import type {
	OrderFilter,
	OrderSummary,
	StoredDecision,
	StoredOrder,
	TradingMode,
	TradingRunRow,
} from "./types";

type RunRow = {
	id: number;
	name: string;
	mode: TradingMode;
	strategy_id: number | null;
	created_at: number;
	enabled: number;
	state: string;
	next_eval_at: number | null;
	reevaluate: number;
	started_at: number | null;
	initial_cash: number;
	account: string | null;
	reset_at: number;
};

const toRun = (r: RunRow): TradingRunRow => ({
	id: r.id,
	name: r.name,
	mode: r.mode,
	strategyId: r.strategy_id,
	createdAt: r.created_at,
	enabled: r.enabled === 1,
	state: JSON.parse(r.state) as JsonValue,
	nextEvalAt: r.next_eval_at,
	reevaluate: r.reevaluate === 1,
	startedAt: r.started_at,
	initialCash: r.initial_cash,
	// 1日の確定損益・ロットを持つ前に保存した口座も読めるようにする。まだ保存していなければ開始時の資金だけ
	account:
		r.account === null
			? newAccount(r.initial_cash)
			: normalizeAccount(JSON.parse(r.account)),
	resetAt: r.reset_at,
});

type OrderRow = {
	run_id: number;
	mode: TradingMode;
	id: string;
	side: TradeOrder["side"];
	type: TradeOrder["type"];
	price: number | null;
	quantity: number;
	placed_at: number;
	status: TradeOrder["status"];
	filled_at: number | null;
	fill_price: number | null;
	fee: number | null;
	canceled_at: number | null;
	cancel_reason: string | null;
	reason: string;
	pair_id: string | null;
	pnl: number | null;
	exit_kind: ExitKind | null;
	buy_name: string | null;
	decision_id: number | null;
	strategy_id: number | null;
	strategy_name: string;
	lot_price?: number | null;
};

/** 売りが売るロットの買値を添えて注文を読む列 */
const ORDER_COLUMNS = `*, (select p.fill_price from trading_orders p
	where trading_orders.side = 'sell' and p.run_id = trading_orders.run_id and p.id = trading_orders.pair_id) as lot_price`;

const toOrder = (r: OrderRow): StoredOrder => ({
	runId: r.run_id,
	mode: r.mode,
	id: r.id,
	side: r.side,
	type: r.type,
	price: r.price,
	quantity: r.quantity,
	placedAt: r.placed_at,
	status: r.status,
	filledAt: r.filled_at,
	fillPrice: r.fill_price,
	fee: r.fee,
	canceledAt: r.canceled_at,
	cancelReason: r.cancel_reason,
	reason: r.reason,
	pairId: r.pair_id,
	pnl: r.pnl,
	decisionId: r.decision_id,
	strategyId: r.strategy_id,
	strategyName: r.strategy_name,
	buyName: r.buy_name,
	lotPrice: r.lot_price ?? null,
	// exit_kind を足す前の売りは理由から読む
	exitKind: inferExitKind(
		{ side: r.side, reason: r.reason, exitKind: r.exit_kind },
		r.lot_price ?? null,
	),
});

function orderWhere(filter: OrderFilter): {
	where: string;
	args: (string | number)[];
} {
	const where: string[] = [];
	const args: (string | number)[] = [];
	if (filter.runId !== undefined) {
		where.push("run_id = ?");
		args.push(filter.runId);
	}
	if (filter.status) {
		where.push("status = ?");
		args.push(filter.status);
	}
	if (filter.side) {
		where.push("side = ?");
		args.push(filter.side);
	}
	return { where: where.length ? `where ${where.join(" and ")}` : "", args };
}

/** 既定の開始時の資金（円） */
export const DEFAULT_INITIAL_CASH = 1_000_000;

export class TradingRepository {
	constructor(private readonly db: Db) {}

	private get sql() {
		return this.db.$client;
	}

	transaction<T>(fn: () => T): T {
		return this.sql.transaction(fn)();
	}

	/** 削除していない運用（作った順） */
	runs(): TradingRunRow[] {
		return this.sql
			.query<RunRow, []>(
				"select * from trading_runs where deleted_at is null order by id",
			)
			.all()
			.map(toRun);
	}

	/** 削除していない運用の id（作った順）。口座を読まずに済ませる */
	runIds(): number[] {
		return this.sql
			.query<{ id: number }, []>(
				"select id from trading_runs where deleted_at is null order by id",
			)
			.all()
			.map((r) => r.id);
	}

	/** 削除していない運用が選んでいる戦略の id */
	strategyIds(): number[] {
		return this.sql
			.query<{ strategy_id: number }, []>(
				"select distinct strategy_id from trading_runs where deleted_at is null and strategy_id is not null",
			)
			.all()
			.map((r) => r.strategy_id);
	}

	/** 削除していない運用 */
	run(id: number): TradingRunRow | null {
		const r = this.sql
			.query<RunRow, [number]>(
				"select * from trading_runs where id = ? and deleted_at is null",
			)
			.get(id);
		return r ? toRun(r) : null;
	}

	/** 運用を足す。口座は開始時の資金だけで作る */
	createRun(
		input: { name: string; mode: TradingMode; strategyId: number | null },
		now: number,
	): number {
		return Number(
			this.sql.run(
				`insert into trading_runs (name, mode, strategy_id, created_at, enabled, state, reevaluate, initial_cash, account, reset_at)
				values (?, ?, ?, ?, 0, 'null', 0, ?, null, ?)`,
				[
					input.name,
					input.mode,
					input.strategyId,
					now,
					DEFAULT_INITIAL_CASH,
					now,
				],
			).lastInsertRowid,
		);
	}

	/** 運用を1つも持っていなければ、既定の資金のペーパーを1つ作る（タブは最低1つ） */
	ensureRun(now: number): void {
		const r = this.sql
			.query<{ n: number }, []>(
				"select count(*) as n from trading_runs where deleted_at is null",
			)
			.get();
		if ((r?.n ?? 0) === 0) {
			this.createRun(
				{ name: "ペーパー", mode: "paper", strategyId: null },
				now,
			);
		}
	}

	/** 実行状態・名前・戦略・口座を保存する */
	saveRun(row: TradingRunRow): void {
		this.sql.run(
			`update trading_runs set name = ?, strategy_id = ?, enabled = ?, state = ?, next_eval_at = ?, reevaluate = ?, started_at = ?,
			initial_cash = ?, account = ?, reset_at = ? where id = ?`,
			[
				row.name,
				row.strategyId,
				row.enabled ? 1 : 0,
				JSON.stringify(row.state),
				row.nextEvalAt,
				row.reevaluate ? 1 : 0,
				row.startedAt,
				row.initialCash,
				JSON.stringify(row.account),
				row.resetAt,
				row.id,
			],
		);
	}

	/** 運用を消す。注文・判断の記録から名前を引けるよう、行は残す */
	deleteRun(id: number, now: number): void {
		this.sql.run("update trading_runs set deleted_at = ? where id = ?", [
			now,
			id,
		]);
	}

	/** 注文の記録を最新の内容にする。新しい注文なら発注した判断と戦略を付けて足す */
	saveOrders(
		run: { id: number; mode: TradingMode },
		orders: readonly TradeOrder[],
		origin: {
			decisionId: number | null;
			strategyId: number | null;
			strategyName: string;
		},
	): void {
		const stmt = this.sql.prepare(
			`insert into trading_orders (run_id, mode, id, side, type, price, quantity, placed_at, status, filled_at, fill_price, fee, canceled_at, cancel_reason, reason, pair_id, pnl, exit_kind, buy_name, decision_id, strategy_id, strategy_name)
			values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			on conflict (run_id, id) do update set status = excluded.status, filled_at = excluded.filled_at, fill_price = excluded.fill_price, fee = excluded.fee,
			canceled_at = excluded.canceled_at, cancel_reason = excluded.cancel_reason, pair_id = excluded.pair_id, pnl = excluded.pnl`,
		);
		for (const o of orders) {
			stmt.run(
				run.id,
				run.mode,
				o.id,
				o.side,
				o.type,
				o.price,
				o.quantity,
				o.placedAt,
				o.status,
				o.filledAt,
				o.fillPrice,
				o.fee,
				o.canceledAt,
				o.cancelReason,
				o.reason,
				o.pairId,
				o.pnl,
				o.exitKind ?? null,
				o.buyName ?? null,
				origin.decisionId,
				origin.strategyId,
				origin.strategyName,
			);
		}
	}

	order(runId: number, id: string): StoredOrder | null {
		const r = this.sql
			.query<OrderRow, [number, string]>(
				`select ${ORDER_COLUMNS} from trading_orders where run_id = ? and id = ?`,
			)
			.get(runId, id);
		return r ? toOrder(r) : null;
	}

	/** 注文を新しい順に。約定・取消の時刻があればその時刻、無ければ発注時刻で並べる */
	orders(filter: OrderFilter = {}, limit = 1000): StoredOrder[] {
		const { where, args } = orderWhere(filter);
		return this.sql
			.query<OrderRow, (string | number)[]>(
				`select ${ORDER_COLUMNS} from trading_orders ${where}
				order by coalesce(filled_at, canceled_at, placed_at) desc, placed_at desc, id desc limit ?`,
			)
			.all(...args, limit)
			.map(toOrder);
	}

	/** from より後に約定した注文を約定の古い順に。リセットと同じ時刻の約定はリセット前の口座のもの */
	filledSince(runId: number, from: number): StoredOrder[] {
		return this.sql
			.query<OrderRow, [number, number]>(
				`select ${ORDER_COLUMNS} from trading_orders where run_id = ? and status = 'filled' and filled_at > ? order by filled_at, placed_at, id`,
			)
			.all(runId, from)
			.map(toOrder);
	}

	/** 条件に合う注文の件数と、損益の合計（件数で切らない） */
	orderSummary(filter: OrderFilter = {}): OrderSummary {
		const { where, args } = orderWhere(filter);
		const r = this.sql
			.query<{ count: number; pnl: number }, (string | number)[]>(
				`select count(*) as count, coalesce(sum(pnl), 0) as pnl from trading_orders ${where}`,
			)
			.get(...args);
		return { count: r?.count ?? 0, realizedPnl: r?.pnl ?? 0 };
	}

	addDecision(
		run: { id: number; mode: TradingMode },
		strategy: { id: number | null; name: string },
		decision: DecisionLog,
		judgments: Record<string, string>,
	): number {
		return Number(
			this.sql.run(
				"insert into trading_decisions (run_id, mode, strategy_id, strategy_name, time, decision, judgments) values (?, ?, ?, ?, ?, ?, ?)",
				[
					run.id,
					run.mode,
					strategy.id,
					strategy.name,
					decision.time,
					JSON.stringify(decision),
					JSON.stringify(judgments),
				],
			).lastInsertRowid,
		);
	}

	decision(id: number): StoredDecision | null {
		const r = this.sql
			.query<
				{
					id: number;
					run_id: number;
					mode: TradingMode;
					strategy_id: number | null;
					strategy_name: string;
					decision: string;
					judgments: string;
				},
				[number]
			>("select * from trading_decisions where id = ?")
			.get(id);
		return r
			? {
					id: r.id,
					runId: r.run_id,
					mode: r.mode,
					strategyId: r.strategy_id,
					strategyName: r.strategy_name,
					decision: JSON.parse(r.decision) as DecisionLog,
					judgments: JSON.parse(r.judgments) as Record<string, string>,
				}
			: null;
	}
}
