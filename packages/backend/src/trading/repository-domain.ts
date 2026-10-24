import type {
	Account,
	DecisionLog,
	JsonValue,
	TradeOrder,
} from "@trading-studio/core";
import type {
	OrderFilter,
	OrderSummary,
	StoredDecision,
	StoredOrder,
	TradingMode,
} from "./types-domain";

export interface TradingRepository {
	transaction<T>(fn: () => T): T;
	/** 削除していない口座（作った順） */
	runs(): TradingRunRow[];
	/** 削除していない口座の id（作った順）。口座を読まずに済ませる */
	runIds(): number[];
	/** オンの口座の数。口座を読まずに数える */
	runningCount(): number;
	/** 削除していない口座 */
	run(id: number): TradingRunRow | null;
	/** 戦略の削除していない口座 */
	runOf(strategyId: number): TradingRunRow | null;
	/** 戦略の口座を作る。デモで、口座は開始時の資金だけで作る */
	createRun(strategy: { id: number; name: string }, now: number): number;
	/** 実行状態・口座を保存する */
	saveRun(row: TradingRunRow): void;
	/** 口座を消す。注文・判断の記録から名前を引けるよう、行は残す */
	deleteRun(id: number, now: number): void;
	/** 注文の記録を最新の内容にする。新しい注文なら発注した判断と戦略を付けて足す */
	saveOrders(
		run: {
			id: number;
			mode: TradingMode;
		},
		orders: readonly TradeOrder[],
		origin: {
			/** 銘柄を持たない注文の銘柄の id（口座の先頭の銘柄） */
			instrument: string;
			decisionId: number | null;
			strategyId: number | null;
			strategyName: string;
		},
	): void;
	order(runId: number, id: string): StoredOrder | null;
	/** 注文を新しい順に。約定・取消の時刻があればその時刻、無ければ発注時刻で並べる */
	orders(filter?: RunOrderFilter, limit?: number): StoredOrder[];
	/** from より後に約定した注文を約定の古い順に。リセットと同じ時刻の約定はリセット前の口座のもの */
	filledSince(runId: number, from: number): StoredOrder[];
	/** 条件に合う注文の件数と、損益の合計（件数で切らない） */
	orderSummary(filter?: RunOrderFilter): Omit<OrderSummary, "currency">;
	addDecision(
		run: {
			id: number;
			mode: TradingMode;
		},
		strategy: {
			id: number | null;
			name: string;
		},
		decision: DecisionLog,
		judgments: Record<string, string>,
	): number;
	decision(id: number): StoredDecision | null;
}

/** 注文の絞り込み。戦略の代わりに口座で指定する */
export type RunOrderFilter = Omit<OrderFilter, "strategyId"> & {
	runId?: number;
};

/** 戦略の口座と実行状態の行 */
export type TradingRunRow = {
	id: number;
	name: string;
	mode: TradingMode;
	/** 口座を持つ戦略。統合前に作った削除済みの行は null がある */
	strategyId: number | null;
	createdAt: number;
	enabled: boolean;
	state: JsonValue;
	nextEvalAt: number | null;
	/** 自分の注文が約定したので、次の見回りで評価し直す */
	reevaluate: boolean;
	startedAt: number | null;
	initialCash: number;
	account: Account;
	resetAt: number;
};
