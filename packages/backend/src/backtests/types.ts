// バックテストの API が使う型。app.ts から参照されるため、Bun 固有の型を持ち込まない

import type {
	BacktestOrder,
	BacktestSummary,
	ConditionSet,
	FeeRates,
	Gap,
	Timeframe,
	ValidationError,
} from "@trading-studio/core";
import type { StoredStrategy } from "../strategies/types";

export type BacktestStatus = "running" | "done" | "failed" | "canceled";

export type BacktestInput = {
	/** 元の戦略。条件は保存済みから変えて試すことがあるので、中身は params で受ける */
	strategyId: number | null;
	params: ConditionSet;
	from: number;
	/** この時刻は含まない */
	to: number;
	initialCash: number;
	fees: FeeRates;
	/** 期間内の欠損を承知で実行する */
	skipGaps: boolean;
};

export type BacktestRun = {
	id: number;
	strategyId: number | null;
	/** 元の戦略の今の名前。削除済みなら実行したときの名前 */
	strategyName: string;
	/** 元の戦略が残っているか */
	strategyExists: boolean;
	params: ConditionSet;
	timeframe: Timeframe;
	from: number;
	to: number;
	initialCash: number;
	fees: FeeRates;
	skipGaps: boolean;
	/** 判定と約定に使った足の粒度 */
	stepTimeframe: Timeframe;
	/** データが足りず、判定頻度より粗い間隔でしか判定できなかった */
	stepLimited: boolean;
	status: BacktestStatus;
	/** 実行中の進み具合（0〜1） */
	progress: number;
	startedAt: number;
	finishedAt: number | null;
	barCount: number;
	summary: BacktestSummary | null;
	filledCount: number;
	orderCount: number;
	error: string | null;
};

/** チャートに出す注文。時刻と価格は、約定・取消・発注のうち最後の状態のもの */
export type BacktestMarker = {
	id: string;
	side: BacktestOrder["side"];
	status: BacktestOrder["status"];
	time: number;
	price: number;
};

/** チャートに出す足と注文 */
export type BacktestChart = {
	bars: { time: number; close: number }[];
	markers: BacktestMarker[];
};

export type OrderFilter = "filled" | "all";

export type StartBacktestResult =
	| { ok: true; run: BacktestRun }
	| { ok: false; error: StartBacktestFailure };

export type StartBacktestFailure =
	| { kind: "busy"; run: BacktestRun }
	| { kind: "invalid_params"; errors: ValidationError[] }
	| { kind: "invalid_input"; field: string; message: string }
	/** データが無い・粗いなど、実行できない */
	| { kind: "no_data"; message: string }
	/** 期間内に欠損がある。skipGaps で実行し直せる */
	| { kind: "gaps"; gaps: Gap[]; gapCount: number; missingBars: number };

export type SaveRunResult =
	| { ok: true; strategy: StoredStrategy }
	| { ok: false; kind: "not_found" }
	| { ok: false; kind: "no_strategy" }
	| { ok: false; kind: "strategy"; status: 400 | 404 | 409; message: string };

export interface BacktestService {
	start(input: BacktestInput): StartBacktestResult;
	get(id: number): BacktestRun | null;
	/** 実行中のバックテスト。無ければ null */
	current(): BacktestRun | null;
	/** 実行中なら中止を求める。中止は計算の区切りで効く */
	cancel(id: number): BacktestRun | null;
	list(): BacktestRun[];
	chart(id: number): BacktestChart | null;
	orders(
		id: number,
		filter: OrderFilter,
		offset: number,
		limit: number,
	): { orders: BacktestOrder[]; total: number } | null;
	order(id: number, orderId: string): BacktestOrder | null;
	/** 結果の条件を元の戦略へ上書きするか、新しい戦略として保存する */
	saveToStrategy(
		id: number,
		to: { overwrite: true } | { name: string },
	): SaveRunResult;
}
