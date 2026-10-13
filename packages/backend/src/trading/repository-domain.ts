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
	/** 削除していない運用（作った順） */
	runs(): TradingRunRow[];
	/** 削除していない運用の id（作った順）。口座を読まずに済ませる */
	runIds(): number[];
	/** 削除していない運用が選んでいる戦略の id */
	strategyIds(): number[];
	/** 削除していない運用 */
	run(id: number): TradingRunRow | null;
	/** 運用を足す。口座は開始時の資金だけで作る */
	createRun(
		input: {
			name: string;
			mode: TradingMode;
			strategyId: number | null;
		},
		now: number,
	): number;
	/** 運用を1つも持っていなければ、既定の資金のデモを1つ作る（タブは最低1つ） */
	ensureRun(now: number): void;
	/** 実行状態・名前・戦略・口座を保存する */
	saveRun(row: TradingRunRow): void;
	/** 運用を消す。注文・判断の記録から名前を引けるよう、行は残す */
	deleteRun(id: number, now: number): void;
	/** 注文の記録を最新の内容にする。新しい注文なら発注した判断と戦略を付けて足す */
	saveOrders(
		run: {
			id: number;
			mode: TradingMode;
		},
		orders: readonly TradeOrder[],
		origin: {
			decisionId: number | null;
			strategyId: number | null;
			strategyName: string;
		},
	): void;
	order(runId: number, id: string): StoredOrder | null;
	/** 注文を新しい順に。約定・取消の時刻があればその時刻、無ければ発注時刻で並べる */
	orders(filter?: OrderFilter, limit?: number): StoredOrder[];
	/** from より後に約定した注文を約定の古い順に。リセットと同じ時刻の約定はリセット前の口座のもの */
	filledSince(runId: number, from: number): StoredOrder[];
	/** 条件に合う注文の件数と、損益の合計（件数で切らない） */
	orderSummary(filter?: OrderFilter): OrderSummary;
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

/** 運用（ホームのタブ1つ）の行。モード・戦略・口座・実行状態を運用ごとに持つ */
export type TradingRunRow = {
	id: number;
	name: string;
	mode: TradingMode;
	/** 運用する戦略。オン中は動かしている戦略 */
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
