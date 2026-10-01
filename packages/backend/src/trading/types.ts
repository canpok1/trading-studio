// 自動取引の API が使う型。app.ts から参照されるため、Bun 固有の型を持ち込まない

import type {
	DecisionLog,
	ExitKind,
	JsonValue,
	Lot,
	Position,
	TradeOrder,
	ValidationError,
} from "@trading-studio/core";

/** paper: ペーパー（最新の実データで模擬売買） / live: ライブ（実資金。フェーズ5で有効にする） */
export type TradingMode = "paper" | "live";

export type StoredOrder = TradeOrder & {
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
	mode?: TradingMode;
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
	mode: TradingMode;
	strategyId: number | null;
	strategyName: string;
	decision: DecisionLog;
	/** 判定器 → そのときの判定の値 */
	judgments: Record<string, string>;
};

export type AutoTradingRow = {
	enabled: boolean;
	mode: TradingMode;
	/** オンにしたときの運用する戦略 */
	strategyId: number | null;
	state: JsonValue;
	nextEvalAt: number | null;
	/** 自分の注文が約定したので、次の見回りで評価し直す */
	reevaluate: boolean;
	startedAt: number | null;
};

export type TradingAccountView = {
	mode: TradingMode;
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

export type AutoTradingStatus = {
	enabled: boolean;
	mode: TradingMode;
	/** オン中は動かしている戦略、オフ中は運用する戦略。無ければ null */
	strategy: { id: number; name: string } | null;
	/** 次の判定時刻。オフなら、今オンにしたときの最初の判定時刻（戦略が無ければ null） */
	nextEvalAt: number | null;
	startedAt: number | null;
	/** 価格の収集が止まっていて判定を待っている */
	waitingForMarket: boolean;
	/** 今日（JST）の確定損失（円、損が無ければ 0）と、戦略の1日の損失上限。上限に達していれば新しい買いを止めている */
	dailyLoss: { loss: number; limit: number | null; blocked: boolean };
	account: TradingAccountView;
	/**
	 * strategy の条件の編集・運用する戦略の切り替え・削除を止めている理由。
	 * running=自動取引がオン、holding=口座に保有か未約定の注文がある。止めていなければ null
	 */
	strategyLock: StrategyLock | null;
};

export type StrategyLock = "running" | "holding";

export type TradingFailure =
	| { kind: "running"; message: string }
	| { kind: "not_running"; message: string }
	| { kind: "no_strategy"; message: string }
	| { kind: "invalid_strategy"; message: string; errors: ValidationError[] }
	| { kind: "unsupported_mode"; message: string }
	| { kind: "invalid_cash"; message: string };

export type TradingResult =
	| { ok: true; status: AutoTradingStatus }
	| { ok: false; error: TradingFailure };

export interface TradingService {
	status(): AutoTradingStatus;
	/** 運用する戦略で自動取引をオンにする */
	start(mode: TradingMode): TradingResult;
	/** オフにする。未約定の注文は取り消さない */
	stop(): TradingResult;
	/** 口座を開始時の資金に戻す。オフのときだけ */
	reset(initialCash: number): TradingResult;
	/** 新しい順に最大 limit 件 */
	orders(filter: OrderFilter, limit?: number): StoredOrder[];
	/** 件数で切らずに数えた、条件に合う注文の件数と実現損益 */
	orderSummary(filter: OrderFilter): OrderSummary;
	/** 口座をリセットした時点以降の成績 */
	performance(mode: TradingMode): TradingPerformance;
	order(
		mode: TradingMode,
		id: string,
	): { order: StoredOrder; decision: StoredDecision | null } | null;
}
