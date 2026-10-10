// バックテストの実行ジョブ。同時に動かすのは1つだけで、画面は進捗を定期的に問い合わせる

import type { AggregationRule, Candle, Timeframe } from "@trading-studio/core";
import {
	acceptsNoJudgment,
	BacktestError,
	candleTimeframes,
	checkDataResolution,
	chooseStepTimeframe,
	conditionStrategy,
	maxWindowMs,
	TIMEFRAME_MS,
	validateConditionSet,
	withSellDetails,
} from "@trading-studio/core";
import type { JudgmentService } from "../judgments/types";
import { MAX_CHART_BARS } from "../market/service";
import type { MarketDataRepository } from "../market-data/repository";
import type { ScoringService } from "../news/types";
import type { Segment, SegmentService } from "../segments/types";
import { checkName } from "../strategies/service";
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
	judgments: Pick<
		JudgmentService,
		| "rule"
		| "series"
		| "firstScoredAt"
		| "scoredNews"
		| "newsDelayMs"
		| "newsDataVersion"
	>;
	scoring: Pick<ScoringService, "rescoreCoverage">;
	segments: Pick<SegmentService, "get">;
	now?: () => number;
};

const fail = (error: StartBacktestFailure): StartBacktestResult => ({
	ok: false,
	error,
});

type Plan = {
	input: BacktestInput;
	segment: Segment | null;
	finest: Timeframe;
	step: { timeframe: Timeframe; limited: boolean };
	rule: AggregationRule;
	usesJudgments: boolean;
	firstScoredAt: number | null;
	criteriaVersion: number | null;
	newsDelayMs: number | null;
	newsFrom: number;
};

type Planned =
	| { ok: true; plan: Plan }
	| { ok: false; error: StartBacktestFailure };

const planFail = (error: StartBacktestFailure): Planned => ({
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
	const nameError = checkName(input.name);
	if (nameError) return bad("name", nameError);
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
	judgments,
	scoring,
	segments,
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

	/** 実行の前の検証。通れば実行に使う値を返す。実行中かどうかは見ない */
	function plan(requested: BacktestInput): Planned {
		const segment =
			requested.segmentId === null ? null : segments.get(requested.segmentId);
		if (requested.segmentId !== null && !segment) {
			return planFail({
				kind: "invalid_input",
				field: "segment",
				message: "相場データが見つからない。選び直す",
			});
		}
		const input = segment
			? { ...requested, from: segment.from, to: segment.to }
			: requested;
		const errors = validateConditionSet(input.params);
		if (errors.length > 0) return planFail({ kind: "invalid_params", errors });
		const invalid = checkInput(input);
		if (invalid) return planFail(invalid);

		const { params, from, to } = input;
		const needed = candleTimeframes(params);
		// 条件の足より細かいデータがあれば、条件の足は自動で作られている
		const finest = marketData.importedTimeframes(from, to)[0];
		if (!finest) {
			return planFail({
				kind: "no_data",
				message:
					"期間に取り込み済みのデータが無い。期間を変えるか、過去データを取り込む",
			});
		}
		try {
			checkDataResolution(finest, needed[0] ?? null);
		} catch (e) {
			if (e instanceof BacktestError) {
				return planFail({ kind: "no_data", message: e.message });
			}
			throw e;
		}
		// 記録が始まる前はデータなしとして渡す。判定の条件のどれにも「データなし」が無ければ、
		// 判定の条件が効いていない結果を正しいものと誤読しやすいので実行しない
		const rule = judgments.rule();
		const usesJudgments = conditionStrategy.requiredJudges(params).length > 0;
		const firstScoredAt = usesJudgments
			? judgments.firstScoredAt(segment?.from ?? null)
			: null;
		if (
			usesJudgments &&
			(firstScoredAt === null || from < firstScoredAt) &&
			!acceptsNoJudgment(params)
		) {
			return planFail({
				kind: "no_judgments",
				firstScoredAt,
				message:
					firstScoredAt === null
						? "市場評価の条件があるが、ニュースの採点の記録がまだ無いため実行できない。市場評価の条件で「データなし」を選ぶと実行できる"
						: "市場評価の条件があるが、期間に採点の記録が始まる前が含まれるため実行できない。開始を記録が始まった日時より後の日にするか、市場評価の条件で「データなし」を選ぶと実行できる",
			});
		}
		// 版を指定したら、期間の市場評価に使う記事がすべてその版で採点されているときだけ実行する。
		// 一部の記事だけで比べると、成績の差が版の違いによるのか記事の数の違いによるのか分からないため
		const criteriaVersion = usesJudgments ? input.criteriaVersion : null;
		// 記事は公開から取得の間隔だけ遅れて知る前提で使う（運用で採点を待つ分を見込む。docs/news.md）
		const newsDelayMs = usesJudgments ? judgments.newsDelayMs() : null;
		// 期間の頭で使うニュースは、期間の開始から集計に使う一番長い長さだけ前から使い始めている
		const newsFrom = from - maxWindowMs(rule);
		if (criteriaVersion !== null) {
			const r = scoring.rescoreCoverage(from, to, criteriaVersion);
			if (!r.ok) {
				return planFail({
					kind: "invalid_input",
					field: "criteriaVersion",
					message: r.message,
				});
			}
			const c = r.coverage;
			if (c.done + c.failed < c.total) {
				return planFail({
					kind: "missing_scores",
					version: criteriaVersion,
					coverage: c,
					message: `期間の市場評価に使う記事のうち ${c.total - c.done - c.failed} 件に v${criteriaVersion} の採点が無いため実行できない。v${criteriaVersion} で採点し直すと実行できる`,
				});
			}
		}
		// 判定頻度が戦略の粒度より短ければ、細かい足で判定する
		const step = chooseStepTimeframe(params, finest);
		const gaps = marketData.gaps(step.timeframe, from, to);
		if (gaps.length > 0 && !input.skipGaps) {
			return planFail({
				kind: "gaps",
				gaps: gaps.slice(0, MAX_GAPS),
				gapCount: gaps.length,
				missingBars: gaps.reduce((n, g) => n + g.missing, 0),
			});
		}
		// 足はまとめて実行するときに件数ぶん読むと重いので、実行を始めるときに読む
		if (marketData.countCandles(step.timeframe, from, to) === 0) {
			return {
				ok: false,
				error: { kind: "no_data", message: "期間に足が無い" },
			};
		}
		return {
			ok: true,
			plan: {
				input,
				segment,
				finest,
				step,
				rule,
				usesJudgments,
				firstScoredAt,
				criteriaVersion,
				newsDelayMs,
				newsFrom,
			},
		};
	}

	return {
		check(input) {
			const r = plan(input);
			return r.ok ? null : r.error;
		},

		start(requested, opts = {}) {
			if (current) {
				return fail({ kind: "busy", run: get(current.id) as BacktestRun });
			}
			const planned = plan(requested);
			if (!planned.ok) return fail(planned.error);
			const {
				input,
				segment,
				finest,
				step,
				rule,
				usesJudgments,
				firstScoredAt,
				criteriaVersion,
				newsDelayMs,
				newsFrom,
			} = planned.plan;
			const { params, from, to } = input;
			const needed = candleTimeframes(params);
			const needs = conditionStrategy.candleNeeds(params);
			const candles: Partial<Record<Timeframe, Candle[]>> = {};
			for (const tf of needed) {
				const history = needs[tf] ?? 1;
				candles[tf] = marketData.loadCandles(
					tf,
					from - history * TIMEFRAME_MS[tf],
					to,
				);
			}
			const stepCandles = marketData.loadCandles(step.timeframe, from, to);
			const barCount = stepCandles.length;

			const id = repo.create({
				name: input.name.trim(),
				params,
				// 条件で使う最も細かい足。AI アドバイスで注文の前後を見せる足に使う
				timeframe: needed[0] ?? step.timeframe,
				from,
				to,
				initialCash: input.initialCash,
				fees: input.fees,
				skipGaps: input.skipGaps,
				stepTimeframe: step.timeframe,
				stepLimited: step.limited,
				aggregationRule: rule,
				criteriaVersion,
				newsDelayMs,
				newsDataVersion:
					newsDelayMs === null
						? null
						: judgments.newsDataVersion(
								newsFrom,
								to,
								criteriaVersion,
								newsDelayMs,
							),
				segment: segment ? { id: segment.id, regime: segment.regime } : null,
				datasetRunId: opts.datasetRunId ?? null,
				startedAt: now(),
				barCount,
			});
			let job: RunningJob;
			try {
				job = runner({
					params,
					candles,
					dataTimeframe: finest,
					stepCandles,
					stepTimeframe: step.timeframe,
					from,
					to,
					initialCash: input.initialCash,
					fees: input.fees,
					judgments: usesJudgments
						? {
								news: judgments.scoredNews(
									newsFrom,
									to,
									criteriaVersion,
									newsDelayMs,
								),
								rule,
								since: firstScoredAt,
							}
						: null,
				});
			} catch (e) {
				console.error("backtest failed to start", e);
				repo.finishOther(id, "failed", "計算を始められなかった", now());
				const run = get(id) as BacktestRun;
				opts.onFinish?.(run);
				return { ok: true, run };
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
					// 次の実行を始められるよう、実行中を外してから知らせる
					const run = repo.get(id);
					if (run) opts.onFinish?.(run);
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

		list(filter) {
			const r = repo.list(filter);
			return { ...r, runs: r.runs.map(withProgress) };
		},

		chart(id, timeframe, maxBars = MAX_CHART_BARS) {
			const chart = repo.chart(id);
			const run = repo.get(id);
			if (!chart || !run) return { ok: false, kind: "not_found" };
			const count = marketData.countCandles(timeframe, run.from, run.to);
			if (count > maxBars) {
				return { ok: false, kind: "too_many", count, max: maxBars };
			}
			// チャートの足は画面で選んだ粒度で、期間の足をそのときのデータから読む。
			// データが消えていれば、結果に残した足（日足。戦略が足の粒度を持っていた頃の実行はその粒度）を出す
			const loaded = marketData.loadCandles(timeframe, run.from, run.to);
			const bars = loaded.length > 0 ? loaded : chart.bars;
			const tf = loaded.length > 0 ? timeframe : chart.timeframe;
			const rule = run.aggregationRule;
			const first = bars[0];
			const last = bars.at(-1);
			const tfMs = TIMEFRAME_MS[tf];
			return {
				ok: true,
				chart: {
					...chart,
					timeframe: tf,
					bars:
						loaded.length > 0
							? loaded.map(({ time, open, high, low, close, volume }) => ({
									time,
									open,
									high,
									low,
									close,
									volume,
								}))
							: chart.bars,
					judgments:
						rule && first && last
							? judgments.series(
									first.time,
									last.time + tfMs,
									tfMs,
									rule,
									run.criteriaVersion,
									run.newsDelayMs,
									// 残っている相場データはニュースも残しているので、古いニュースを消した後も背景を出せる
									run.segment && segments.get(run.segment.id) ? run.from : null,
								)
							: null,
				},
			};
		},

		orders(id, filter, offset, limit) {
			const stored = repo.orders(id);
			if (!stored) return null;
			const all = withSellDetails(stored);
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
			const stored = repo.orders(id);
			return stored
				? (withSellDetails(stored).find((o) => o.id === orderId) ?? null)
				: null;
		},

		saveToStrategy(id, name) {
			const run = repo.get(id);
			if (run?.status !== "done") return { ok: false, kind: "not_found" };
			const r = strategies.create({ name, from: { params: run.params } });
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
