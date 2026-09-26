// 自動取引の API が使う型。app.ts から参照されるため、Bun 固有の型を持ち込まない

import type {
	DecisionLog,
	JsonValue,
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
};

export type OrderFilter = {
	mode?: TradingMode;
	status?: TradeOrder["status"];
	side?: TradeOrder["side"];
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
	openOrderCount: number;
	resetAt: number;
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
};

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
	orders(filter: OrderFilter): StoredOrder[];
	order(
		mode: TradingMode,
		id: string,
	): { order: StoredOrder; decision: StoredDecision | null } | null;
}
