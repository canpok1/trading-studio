// バックテストの実行ジョブ。同時に動かすのは1つだけで、画面は進捗を定期的に問い合わせる

import {
	BacktestError,
	checkDataResolution,
	conditionStrategy,
	TIMEFRAME_MS,
	validateConditionSet,
} from "@trading-studio/core";
import type { MarketDataRepository } from "../market-data/repository";
import type { StrategyService } from "../strategies/types";
import type { BacktestRepository } from "./repository";
import type { BacktestRunner, RunningJob } from "./runner";
import type {
	BacktestInput,
	BacktestRun,
	BacktestService,
	StartBacktestFailure,
	StartBacktestResult,
} from "./types";

/** 画面に返す欠損の上限 */
const MAX_GAPS = 50;
const MAX_CASH = 1_000_000_000_000;
/** 手数料率の上限（10%） */
const MAX_FEE_PPM = 100_000;

export type BacktestServiceDeps = {
	repo: BacktestRepository;
	marketData: MarketDataRepository;
	strategies: StrategyService;
	runner: BacktestRunner;
	now?: () => number;
};

const fail = (error: StartBacktestFailure): StartBacktestResult => ({
	ok: false,
	error,
});

function checkInput(input: BacktestInput): StartBacktestFailure | null {
	const bad = (field: string, message: string) =>
		({ kind: "invalid_input", field, message }) as const;
	if (!Number.isSafeInteger(input.from) || !Number.isSafeInteger(input.to)) {
		return bad("period", "期間を入れる");
	}
	if (input.from >= input.to) {
		return bad("period", "終了は開始より後にする");
	}
	if (
		!Number.isSafeInteger(input.initialCash) ||
		input.initialCash <= 0 ||
		input.initialCash > MAX_CASH
	) {
		return bad("initialCash", "1 円以上の整数で入れる");
	}
	for (const [k, v] of Object.entries(input.fees)) {
		if (!Number.isSafeInteger(v) || v < 0 || v > MAX_FEE_PPM) {
			return bad(`fees.${k}`, "0〜10% の範囲で入れる");
		}
	}
	return null;
}

export function createBacktestService({
	repo,
	marketData,
	strategies,
	runner,
	now = Date.now,
}: BacktestServiceDeps): BacktestService & { running(): Promise<void> | null } {
	let current: { id: number; job: RunningJob; done: Promise<void> } | null =
		null;

	const withProgress = (run: BacktestRun): BacktestRun =>
		current?.id === run.id && run.status === "running"
			? { ...run, progress: current.job.progress() }
			: run;

	const get = (id: number) => {
		const r = repo.get(id);
		return r ? withProgress(r) : null;
	};

	return {
		start(input) {
			if (current) {
				return fail({ kind: "busy", run: get(current.id) as BacktestRun });
			}
			const errors = validateConditionSet(input.params);
			if (errors.length > 0) return fail({ kind: "invalid_params", errors });
			const invalid = checkInput(input);
			if (invalid) return fail(invalid);

			const { params, from, to } = input;
			const tf = params.timeframe;
			// 戦略の粒度より細かいデータがあれば、戦略の粒度の足は自動で作られている
			const finest = marketData.importedTimeframes(from, to)[0];
			if (!finest) {
				return fail({
					kind: "no_data",
					message:
						"期間に取り込み済みのデータが無い。期間を変えるか、過去データを取り込む",
				});
			}
			try {
				checkDataResolution(finest, tf);
			} catch (e) {
				if (e instanceof BacktestError) {
					return fail({ kind: "no_data", message: e.message });
				}
				throw e;
			}
			const gaps = marketData.gaps(tf, from, to);
			if (gaps.length > 0 && !input.skipGaps) {
				return fail({
					kind: "gaps",
					gaps: gaps.slice(0, MAX_GAPS),
					gapCount: gaps.length,
					missingBars: gaps.reduce((n, g) => n + g.missing, 0),
				});
			}
			const tfMs = TIMEFRAME_MS[tf];
			const history = conditionStrategy.historyBars(params);
			const candles = marketData.loadCandles(tf, from - history * tfMs, to);
			const barCount = candles.filter((c) => c.time >= from).length;
			if (barCount === 0) {
				return fail({ kind: "no_data", message: "期間に足が無い" });
			}

			const strategy =
				input.strategyId === null ? null : strategies.get(input.strategyId);
			const id = repo.create({
				strategyId: strategy?.id ?? null,
				strategyName: strategy?.name ?? "（保存していない条件）",
				params,
				timeframe: tf,
				from,
				to,
				initialCash: input.initialCash,
				fees: input.fees,
				skipGaps: input.skipGaps,
				startedAt: now(),
				barCount,
			});
			let job: RunningJob;
			try {
				job = runner({
					params,
					candles,
					dataTimeframe: finest,
					from,
					to,
					initialCash: input.initialCash,
					fees: input.fees,
				});
			} catch (e) {
				console.error("backtest failed to start", e);
				repo.finishOther(id, "failed", "計算を始められなかった", now());
				return { ok: true, run: get(id) as BacktestRun };
			}
			const done = job.outcome
				.then((o) => {
					if (o.kind === "done") repo.finishDone(id, o.output, now());
					else if (o.kind === "canceled")
						repo.finishOther(id, "canceled", null, now());
					else repo.finishOther(id, "failed", o.message, now());
				})
				.catch((e: unknown) => {
					console.error("backtest failed", e);
					repo.finishOther(id, "failed", "結果を保存できなかった", now());
				})
				.finally(() => {
					current = null;
				});
			current = { id, job, done };
			return { ok: true, run: get(id) as BacktestRun };
		},

		get,

		current() {
			return current ? get(current.id) : null;
		},

		cancel(id) {
			if (current?.id === id) current.job.cancel();
			return get(id);
		},

		list() {
			return repo.list().map(withProgress);
		},

		chart(id) {
			return repo.chart(id);
		},

		orders(id, filter, offset, limit) {
			const all = repo.orders(id);
			if (!all) return null;
			// 新しい順に並べる
			const list = (
				filter === "filled" ? all.filter((o) => o.status === "filled") : all
			).reverse();
			return {
				orders: list.slice(offset, offset + limit),
				total: list.length,
			};
		},

		order(id, orderId) {
			return repo.orders(id)?.find((o) => o.id === orderId) ?? null;
		},

		saveToStrategy(id, to) {
			const run = repo.get(id);
			if (run?.status !== "done") return { ok: false, kind: "not_found" };
			let r: ReturnType<StrategyService["create"]>;
			if ("overwrite" in to) {
				if (run.strategyId === null || !run.strategyExists) {
					return { ok: false, kind: "no_strategy" };
				}
				r = strategies.updateParams(run.strategyId, run.params);
			} else {
				r = strategies.create({ name: to.name, from: { params: run.params } });
				// 以後この結果は新しい戦略の条件として扱う
				if (r.ok) repo.setStrategy(id, r.strategy.id);
			}
			if (r.ok) return { ok: true, strategy: r.strategy };
			const e = r.error;
			switch (e.kind) {
				case "not_found":
					return {
						ok: false,
						kind: "strategy",
						status: 404,
						message: "戦略が見つからない",
					};
				case "duplicate_name":
					return {
						ok: false,
						kind: "strategy",
						status: 409,
						message: e.message,
					};
				case "invalid_name":
					return {
						ok: false,
						kind: "strategy",
						status: 400,
						message: e.message,
					};
				case "invalid_params":
					return {
						ok: false,
						kind: "strategy",
						status: 400,
						message: "条件に入力の誤りがある",
					};
			}
		},

		running() {
			return current?.done ?? null;
		},
	};
}
