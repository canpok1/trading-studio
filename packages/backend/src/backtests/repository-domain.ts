import type { BacktestOrder, DecisionLog, Trade } from "@trading-studio/core";
import type { RunnerOutput } from "./runner-domain";
import type {
	BacktestChart,
	BacktestRun,
	RunFilter,
	RunListResult,
} from "./types-domain";

export interface BacktestRepository {
	create(
		run: Omit<
			BacktestRun,
			| "id"
			| "status"
			| "progress"
			| "finishedAt"
			| "summary"
			| "filledCount"
			| "orderCount"
			| "error"
			| "dailyLossLimitApplied"
		>,
	): number;
	finishDone(id: number, out: RunnerOutput, now: number): void;
	finishOther(
		id: number,
		status: "failed" | "canceled",
		error: string | null,
		now: number,
	): void;
	/** サーバーが途中で止まった実行を失敗として残す */
	failInterrupted(now: number): number;
	get(id: number): BacktestRun | null;
	list({ limit, q, hideFailed, sort }?: Partial<RunFilter>): RunListResult;
	/** 開始時刻が [from, to) の完了した実行（新しい順） */
	listDoneStartedBetween(from: number, to: number): BacktestRun[];
	/** instrument は候補の銘柄の id。省くと候補の先頭。候補に無い銘柄は足も注文も空 */
	chart(
		id: number,
		instrument?: string,
	): Omit<BacktestChart, "judgments"> | null;
	/** 往復の取引。結果が無ければ null */
	trades(id: number): Trade[] | null;
	orders(id: number): BacktestOrder[] | null;
	/** 結果の中身（注文・往復の取引・判断ログ）。結果が無ければ null */
	contents(id: number): {
		orders: BacktestOrder[];
		trades: Trade[];
		decisions: DecisionLog[];
	} | null;
}
