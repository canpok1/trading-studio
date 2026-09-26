// 自動取引の口座・注文・判断の記録・実行状態の読み書き

import type {
	Account,
	DecisionLog,
	JsonValue,
	TradeOrder,
} from "@trading-studio/core";
import { newAccount } from "@trading-studio/core";
import type { Db } from "../db/open";
import type {
	AutoTradingRow,
	OrderFilter,
	StoredDecision,
	StoredOrder,
	TradingMode,
} from "./types";

type OrderRow = {
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
	decision_id: number | null;
	strategy_id: number | null;
	strategy_name: string;
};

const toOrder = (r: OrderRow): StoredOrder => ({
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
});

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

	/** 口座。まだ無ければ既定の資金で作る */
	account(
		mode: TradingMode,
		now: number,
	): { initialCash: number; account: Account; resetAt: number } {
		const row = this.sql
			.query<
				{ initial_cash: number; account: string; reset_at: number },
				[string]
			>(
				"select initial_cash, account, reset_at from trading_accounts where mode = ?",
			)
			.get(mode);
		if (row) {
			return {
				initialCash: row.initial_cash,
				// 1日の確定損益を持つ前に保存した口座も読めるようにする
				account: {
					today: { dayStart: 0, pnl: 0 },
					...(JSON.parse(row.account) as Partial<Account>),
				} as Account,
				resetAt: row.reset_at,
			};
		}
		const account = newAccount(DEFAULT_INITIAL_CASH);
		this.sql.run(
			"insert into trading_accounts (mode, initial_cash, account, reset_at) values (?, ?, ?, ?)",
			[mode, DEFAULT_INITIAL_CASH, JSON.stringify(account), now],
		);
		return { initialCash: DEFAULT_INITIAL_CASH, account, resetAt: now };
	}

	saveAccount(mode: TradingMode, account: Account): void {
		this.sql.run("update trading_accounts set account = ? where mode = ?", [
			JSON.stringify(account),
			mode,
		]);
	}

	resetAccount(
		mode: TradingMode,
		initialCash: number,
		account: Account,
		now: number,
	): void {
		this.sql.run(
			"update trading_accounts set initial_cash = ?, account = ?, reset_at = ? where mode = ?",
			[initialCash, JSON.stringify(account), now, mode],
		);
	}

	/** 注文の記録を最新の内容にする。新しい注文なら発注した判断と戦略を付けて足す */
	saveOrders(
		mode: TradingMode,
		orders: readonly TradeOrder[],
		origin: {
			decisionId: number | null;
			strategyId: number | null;
			strategyName: string;
		},
	): void {
		const stmt = this.sql.prepare(
			`insert into trading_orders (mode, id, side, type, price, quantity, placed_at, status, filled_at, fill_price, fee, canceled_at, cancel_reason, reason, pair_id, pnl, decision_id, strategy_id, strategy_name)
			values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			on conflict (mode, id) do update set status = excluded.status, filled_at = excluded.filled_at, fill_price = excluded.fill_price, fee = excluded.fee,
			canceled_at = excluded.canceled_at, cancel_reason = excluded.cancel_reason, pair_id = excluded.pair_id, pnl = excluded.pnl`,
		);
		for (const o of orders) {
			stmt.run(
				mode,
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
				origin.decisionId,
				origin.strategyId,
				origin.strategyName,
			);
		}
	}

	order(mode: TradingMode, id: string): StoredOrder | null {
		const r = this.sql
			.query<OrderRow, [string, string]>(
				"select * from trading_orders where mode = ? and id = ?",
			)
			.get(mode, id);
		return r ? toOrder(r) : null;
	}

	/** 注文を新しい順に。約定・取消の時刻があればその時刻、無ければ発注時刻で並べる */
	orders(filter: OrderFilter = {}, limit = 1000): StoredOrder[] {
		const where: string[] = [];
		const args: (string | number)[] = [];
		if (filter.mode) {
			where.push("mode = ?");
			args.push(filter.mode);
		}
		if (filter.status) {
			where.push("status = ?");
			args.push(filter.status);
		}
		if (filter.side) {
			where.push("side = ?");
			args.push(filter.side);
		}
		args.push(limit);
		return this.sql
			.query<OrderRow, (string | number)[]>(
				`select * from trading_orders ${where.length ? `where ${where.join(" and ")}` : ""}
				order by coalesce(filled_at, canceled_at, placed_at) desc, placed_at desc, id desc limit ?`,
			)
			.all(...args)
			.map(toOrder);
	}

	addDecision(
		mode: TradingMode,
		strategy: { id: number | null; name: string },
		decision: DecisionLog,
		judgments: Record<string, string>,
	): number {
		return Number(
			this.sql.run(
				"insert into trading_decisions (mode, strategy_id, strategy_name, time, decision, judgments) values (?, ?, ?, ?, ?, ?)",
				[
					mode,
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
					mode: r.mode,
					strategyId: r.strategy_id,
					strategyName: r.strategy_name,
					decision: JSON.parse(r.decision) as DecisionLog,
					judgments: JSON.parse(r.judgments) as Record<string, string>,
				}
			: null;
	}

	/** 自動取引の実行状態。まだ無ければオフで作る */
	autoTrading(): AutoTradingRow {
		const r = this.sql
			.query<
				{
					enabled: number;
					mode: TradingMode;
					strategy_id: number | null;
					state: string;
					next_eval_at: number | null;
					reevaluate: number;
					started_at: number | null;
				},
				[]
			>("select * from auto_trading where id = 1")
			.get();
		if (!r) {
			const row: AutoTradingRow = {
				enabled: false,
				mode: "paper",
				strategyId: null,
				state: null,
				nextEvalAt: null,
				reevaluate: false,
				startedAt: null,
			};
			this.saveAutoTrading(row);
			return row;
		}
		return {
			enabled: r.enabled === 1,
			mode: r.mode,
			strategyId: r.strategy_id,
			state: JSON.parse(r.state) as JsonValue,
			nextEvalAt: r.next_eval_at,
			reevaluate: r.reevaluate === 1,
			startedAt: r.started_at,
		};
	}

	saveAutoTrading(row: AutoTradingRow): void {
		this.sql.run(
			`insert into auto_trading (id, enabled, mode, strategy_id, state, next_eval_at, reevaluate, started_at) values (1, ?, ?, ?, ?, ?, ?, ?)
			on conflict (id) do update set enabled = excluded.enabled, mode = excluded.mode, strategy_id = excluded.strategy_id, state = excluded.state,
			next_eval_at = excluded.next_eval_at, reevaluate = excluded.reevaluate, started_at = excluded.started_at`,
			[
				row.enabled ? 1 : 0,
				row.mode,
				row.strategyId,
				JSON.stringify(row.state),
				row.nextEvalAt,
				row.reevaluate ? 1 : 0,
				row.startedAt,
			],
		);
	}
}
