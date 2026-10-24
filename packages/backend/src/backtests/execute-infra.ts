// バックテストを計算して、保存する形（gzip した JSON）にする。Worker とテストの両方から呼ぶ

import { gzipSync } from "node:zlib";
import type { Candle } from "@trading-studio/core";
import {
	BacktestAborted,
	BacktestError,
	conditionStrategy,
	runBacktest,
} from "@trading-studio/core";
import type { RunnerJob, RunnerOutcome } from "./runner-domain";

const pack = (v: unknown) => gzipSync(JSON.stringify(v));

const packBars = (candles: readonly Candle[]) => ({
	times: candles.map((c) => c.time),
	closes: candles.map((c) => c.close),
	opens: candles.map((c) => c.open),
	highs: candles.map((c) => c.high),
	lows: candles.map((c) => c.low),
});

export function execute(
	job: RunnerJob,
	onProgress: (done: number, total: number) => void,
	shouldAbort: () => boolean,
): RunnerOutcome {
	try {
		const r = runBacktest({
			instrument: job.instrument,
			strategy: conditionStrategy,
			params: job.params,
			candles: job.candles,
			dataTimeframe: job.dataTimeframe,
			stepCandles: job.stepCandles,
			stepTimeframe: job.stepTimeframe,
			from: job.from,
			to: job.to,
			initialCash: job.initialCash,
			fees: job.fees,
			judgments: job.judgments ?? undefined,
			events: job.events,
			dvol: job.dvol,
			otherMarkets: job.otherMarkets,
			onProgress,
			shouldAbort,
		});
		return {
			kind: "done",
			output: {
				summary: r.summary,
				orderCount: r.orders.length,
				filledCount: r.orders.filter((o) => o.status === "filled").length,
				bars: pack({
					timeframe: "1d",
					...packBars(r.candles),
					...(r.otherCandles
						? {
								others: Object.fromEntries(
									Object.entries(r.otherCandles).map(([id, c]) => [
										id,
										packBars(c),
									]),
								),
							}
						: {}),
					...(r.equity
						? {
								equity: {
									times: r.equity.map((c) => c.time),
									closes: r.equity.map((c) => c.close),
								},
							}
						: {}),
				}),
				orders: pack(r.orders),
				trades: pack(r.trades),
				decisions: pack(r.decisions),
			},
		};
	} catch (e) {
		if (e instanceof BacktestAborted) return { kind: "canceled" };
		if (e instanceof BacktestError)
			return { kind: "failed", message: e.message };
		console.error("backtest failed", e);
		return {
			kind: "failed",
			message: `計算中にエラーが起きた: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}
