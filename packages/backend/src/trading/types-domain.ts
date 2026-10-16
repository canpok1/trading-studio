// 自動取引の API が使う型。app.ts から参照されるため、Bun 固有の型を持ち込まない

import type {
	DecisionLog,
	ExitKind,
	Lot,
	Position,
	StrategyWatch,
	TradeOrder,
	ValidationError,
} from "@trading-studio/core";

/** paper: デモ（最新の実データで模擬売買） / live: リアル（実資金。フェーズ5で有効にする） */
export type TradingMode = "paper" | "live";

export type StoredOrder = TradeOrder & {
	/** 口座（trading_runs）の id。注文の id はこの中で振る */
	runId: number;
	mode: TradingMode;
	/** 発注した判断。無ければ null */
	decisionId: number | null;
	strategyId: number | null;
	strategyName: string;
	/** 売りが売るロットの買値（買いの約定価格）。買い・ロットが分からない売りは null */
	lotPrice: number | null;
	/** 売りを出した条件のグループ。買い・読めない過去の売りは null */
	exitKind: ExitKind | null;
};

export type OrderFilter = {
	strategyId?: number;
	status?: TradeOrder["status"];
	side?: TradeOrder["side"];
};

export type OrderSummary = {
	count: number;
	/** 損益（売りの約定の手数料込みの損益）の合計（円） */
	realizedPnl: number;
};

export type StoredDecision = {
	id: number;
	runId: number;
	mode: TradingMode;
	strategyId: number | null;
	strategyName: string;
	decision: DecisionLog;
	/** 判定器 → そのときの判定の値 */
	judgments: Record<string, string>;
};

export type TradingAccountView = {
	initialCash: number;
	cash: number;
	position: Position;
	/** 保有中のロット（買いの約定順） */
	lots: Lot[];
	openOrderCount: number;
	resetAt: number;
	/** 現金と保有を今の価格で評価した資産（手数料は含めない）。保有があって価格が分からなければ null */
	equity: number | null;
};

/** 口座をリセットした時点以降の成績。指標の意味はバックテストの成績（core の BacktestSummary）と同じ */
export type TradingPerformance = {
	resetAt: number;
	initialCash: number;
	cash: number;
	position: Position;
	/** 評価に使った今の価格。分からなければ null */
	price: number | null;
	/** 現金と保有を今の価格で評価した資産。保有があって価格が分からなければ null */
	equity: number | null;
	/** 開始時の資金からの損益（保有の評価を含む） */
	pnl: number | null;
	pnlPercent: number | null;
	/** リセットした時点で買って今まで持っていた場合（ガチホ）の損益率（%、手数料は含めない）。価格が分からなければ null */
	buyHoldPercent: number | null;
	/** 確定した損益（往復の手数料込みの損益の合計） */
	realizedPnl: number;
	/** 往復の回数（未決済は含めない） */
	trades: number;
	wins: number;
	losses: number;
	winRate: number | null;
	profitFactor: number | null;
	/** 最大ドローダウン（%、0 以上）。約定の直後・1時間足の終値・今の時点の資産で測る */
	maxDrawdownPercent: number;
	maxDrawdownFrom: number | null;
	maxDrawdownTo: number | null;
	averageHoldingMs: number | null;
};

/** 戦略1つの自動取引の状態 */
export type AutoTradingStatus = {
	/** 戦略の id */
	id: number;
	/** 戦略の名前 */
	name: string;
	enabled: boolean;
	mode: TradingMode;
	/** 次の判定時刻。オフなら、今オンにしたときの最初の判定時刻 */
	nextEvalAt: number | null;
	startedAt: number | null;
	/** 価格の収集が止まっていて判定を待っている */
	waitingForMarket: boolean;
	/** 今日（JST）の確定損失（円、損が無ければ 0）と、戦略の1日の損失上限。上限に達していれば新しい買いを止めている */
	dailyLoss: { loss: number; limit: number | null; blocked: boolean };
	account: TradingAccountView;
	/**
	 * 戦略の条件の変更を止めている理由。
	 * running=自動取引がオン、holding=口座に保有か未約定の注文がある。止めていなければ null
	 */
	strategyLock: StrategyLock | null;
};

export type StrategyLock = "running" | "holding";

export type TradingFailure =
	| { kind: "running"; message: string }
	| { kind: "not_running"; message: string }
	| { kind: "invalid_strategy"; message: string; errors: ValidationError[] }
	| { kind: "unsupported_mode"; message: string }
	| { kind: "invalid_cash"; message: string }
	| { kind: "not_found"; message: string }
	| { kind: "limit"; message: string }
	| { kind: "locked"; message: string };

export type TradingResult =
	| { ok: true; status: AutoTradingStatus }
	| { ok: false; error: TradingFailure };

/** 戦略ごとの自動取引。戦略1つが口座1つを持つ。引数の id は戦略の id */
export interface TradingService {
	/** 戦略ごとの状態（作った順） */
	runs(): AutoTradingStatus[];
	run(strategyId: number): AutoTradingStatus | null;
	/**
	 * 戦略を今の価格で試算した見張り（条件ごとの成立と発動価格）。注文も state の変更もしない。
	 * 戦略が無ければ null、価格がまだ無ければ watch が null
	 */
	watch(strategyId: number): { watch: StrategyWatch | null } | null;
	/** 戦略を消す。オフのときだけ。未約定の注文は取り消し、保有は捨てる。注文・判断の記録は残す */
	remove(
		strategyId: number,
	): { ok: true } | { ok: false; error: TradingFailure };
	/** 自動取引をオンにする。同時にオンにできるのは core の TRADING_LIMITS.running まで */
	start(strategyId: number): TradingResult;
	/** オフにする。未約定の注文は取り消さない */
	stop(strategyId: number): TradingResult;
	/** 口座を開始時の資金に戻す。オフのときだけ */
	reset(strategyId: number, initialCash: number): TradingResult;
	/** 新しい順に最大 limit 件 */
	orders(filter: OrderFilter, limit?: number): StoredOrder[];
	/** 件数で切らずに数えた、条件に合う注文の件数と実現損益 */
	orderSummary(filter: OrderFilter): OrderSummary;
	/** 口座をリセットした時点以降の成績。戦略が無ければ null */
	performance(strategyId: number): TradingPerformance | null;
	order(
		strategyId: number,
		id: string,
	): { order: StoredOrder; decision: StoredDecision | null } | null;
	/** 戦略の条件の変更を止めている理由。オンなら running、保有か未約定の注文があれば holding。止めていなければ null */
	strategyLock(strategyId: number): StrategyLock | null;
}
