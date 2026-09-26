// バックテストの計算を動かす部品の型。本番は Worker、テストは同じスレッドで動かす

import type {
	BacktestSummary,
	Candle,
	ConditionSet,
	FeeRates,
	Timeframe,
} from "@trading-studio/core";

export type RunnerJob = {
	params: ConditionSet;
	/** 戦略の粒度の足。指標の計算に使うため期間より前の足も含む */
	candles: Candle[];
	dataTimeframe: Timeframe;
	/** 判定と約定に使う期間内の足と粒度。戦略の粒度と同じなら candles を使う */
	stepCandles: Candle[] | null;
	stepTimeframe: Timeframe;
	from: number;
	to: number;
	initialCash: number;
	fees: FeeRates;
};

/** 保存する結果。中身は gzip した JSON */
export type RunnerOutput = {
	summary: BacktestSummary;
	orderCount: number;
	filledCount: number;
	bars: Uint8Array;
	orders: Uint8Array;
	trades: Uint8Array;
	decisions: Uint8Array;
};

export type RunnerOutcome =
	| { kind: "done"; output: RunnerOutput }
	| { kind: "canceled" }
	| { kind: "failed"; message: string };

export type RunningJob = {
	/** 0〜1 */
	progress(): number;
	cancel(): void;
	outcome: Promise<RunnerOutcome>;
};

export type BacktestRunner = (job: RunnerJob) => RunningJob;
