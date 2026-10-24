// バックテストの実行ジョブ。同時に動かすのは1つだけで、画面は進捗を定期的に問い合わせる

import type {
	AggregationRule,
	BacktestMarket,
	BacktestOrder,
	Candle,
	Instrument,
	Timeframe,
} from "@trading-studio/core";
import {
	acceptsNoJudgment,
	BacktestError,
	candleTimeframes,
	checkDataResolution,
	chooseStepTimeframe,
	conditionStrategy,
	eventWindowHours,
	HOUR_MS,
	isCoarser,
	isTimeframe,
	marketOf,
	maxWindowMs,
	parseConditionSet,
	RUN_LIMITS,
	TIMEFRAME_MS,
	validateCandidates,
	validateConditionSet,
	withSellDetails,
} from "@trading-studio/core";
import type { CalendarService } from "../calendar/types-domain";
import { strategyDvol } from "../dvol/dvol-domain";
import type { DvolRepository } from "../dvol/repository-domain";
import type { JudgmentService } from "../judgments/types-domain";
import { MAX_CHART_BARS } from "../market/market-domain";
import { DEFAULT_INSTRUMENT } from "../market-data/instrument-domain";
import type { MarketDataRepository } from "../market-data/repository-domain";
import type { ScoringService } from "../news/types-domain";
import type { Segment, SegmentService } from "../segments/types-domain";
import { checkName } from "../strategies/strategies-domain";
import type { StrategyService } from "../strategies/types-domain";
import type { BacktestRepository } from "./repository-domain";
import type { BacktestRunner, RunningJob } from "./runner-domain";
import type {
	BacktestInput,
	BacktestRun,
	BacktestService,
	ListedBacktestOrder,
	StartBacktestFailure,
	StartBacktestResult,
} from "./types-domain";

/** 画面に返す欠損の上限 */
const MAX_GAPS = 50;
const MAX_CASH = 1_000_000_000_000;
/** 手数料率の上限（10%） */
const MAX_FEE_PPM = 100_000;

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null;

export const num = (v: unknown) => (typeof v === "number" ? v : Number.NaN);

/** 単体の実行とまとめた実行で共通の実行条件の入力の形を確かめる。形が違えば null（値の範囲は start で確かめる） */
export function parseRunConditions(v: unknown) {
	const params = parseConditionSet(isObj(v) ? v.params : null);
	if (!isObj(v) || !params || !isObj(v.fees)) return null;
	// 候補を送らない呼び出し（候補を持つ前の画面・MCP）は BTC/JPY だけ
	const instruments =
		v.instruments === undefined ? [DEFAULT_INSTRUMENT.id] : v.instruments;
	if (
		!Array.isArray(instruments) ||
		!instruments.every((x) => typeof x === "string")
	)
		return null;
	return {
		v,
		conditions: {
			name: typeof v.name === "string" ? v.name : "",
			params,
			initialCash: num(v.initialCash),
			fees: {
				limitPpm: num(v.fees.limitPpm),
				marketPpm: num(v.fees.marketPpm),
			},
			skipGaps: v.skipGaps === true,
			criteriaVersion:
				v.criteriaVersion === undefined || v.criteriaVersion === null
					? null
					: num(v.criteriaVersion),
			eventCriteriaVersion:
				v.eventCriteriaVersion === undefined || v.eventCriteriaVersion === null
					? null
					: num(v.eventCriteriaVersion),
			instruments: instruments as string[],
		},
	};
}

/** 実行条件の入力の形を確かめる。形が違えば null */
export function parseBacktestInput(input: unknown): BacktestInput | null {
	const r = parseRunConditions(input);
	if (!r) return null;
	const { v, conditions } = r;
	return {
		...conditions,
		from: num(v.from),
		to: num(v.to),
		segmentId:
			v.segmentId === undefined || v.segmentId === null
				? null
				: num(v.segmentId),
	};
}

/** 結果のチャートの足の粒度の入力を確かめる */
export function parseChartQuery(
	q: Record<string, unknown>,
): { ok: true; timeframe: Timeframe } | { ok: false; message: string } {
	return isTimeframe(q.timeframe)
		? { ok: true, timeframe: q.timeframe }
		: { ok: false, message: "足の粒度を選ぶ" };
}

export type BacktestServiceDeps = {
	repo: BacktestRepository;
	/** 候補にできる銘柄（収集している銘柄）の足 */
	marketData: readonly MarketData[];
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
	calendar: Pick<
		CalendarService,
		"calendar" | "activeVersion" | "judgmentCoverage"
	>;
	dvol: Pick<DvolRepository, "bars" | "fetchState">;
	now?: () => number;
};

type MarketData = Pick<
	MarketDataRepository,
	"instrument" | "importedTimeframes" | "gaps" | "countCandles" | "loadCandles"
>;

const fail = (error: StartBacktestFailure): StartBacktestResult => ({
	ok: false,
	error,
});

type Plan = {
	input: BacktestInput;
	/** 候補の銘柄の足。先頭が候補の先頭 */
	markets: MarketData[];
	segment: Segment | null;
	finest: Timeframe;
	step: { timeframe: Timeframe; limited: boolean };
	rule: AggregationRule;
	usesJudgments: boolean;
	firstScoredAt: number | null;
	criteriaVersion: number | null;
	newsDelayMs: number | null;
	newsFrom: number;
	/** 予定の前後の条件に使う評価基準の版。予定の前後の条件が無ければ null */
	eventCriteriaVersion: number | null;
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

/** 売りに、売るロットの買値と売りの条件のグループを添える。価格の単位は注文の銘柄のもの */
function listed(
	stored: readonly BacktestOrder[],
	run: BacktestRun,
): ListedBacktestOrder[] {
	const primary = run.instrument.id;
	const byId = new Map(
		run.instruments.flatMap((i) =>
			withSellDetails(
				stored.filter((o) => (o.instrument ?? primary) === i.id),
				i,
			).map((o) => [o.id, o] as const),
		),
	);
	return stored.flatMap((o) => byId.get(o.id) ?? []);
}

export function createBacktestService({
	repo,
	marketData,
	strategies,
	runner,
	judgments,
	scoring,
	segments,
	calendar,
	dvol,
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
		const markets = input.instruments.map((id) =>
			marketData.find((m) => m.instrument.id === id),
		);
		if (!markets.every((m) => m !== undefined)) {
			return planFail({
				kind: "invalid_input",
				field: "instruments",
				message: "価格を集めていない銘柄は候補にできない",
			});
		}
		const instruments = markets.map((m) => m.instrument);
		const primary = instruments[0] as Instrument | undefined;
		const errors = [
			...validateCandidates(input.params, instruments),
			...(primary
				? validateConditionSet(input.params, marketOf(primary), RUN_LIMITS)
				: []),
		];
		if (errors.length > 0) return planFail({ kind: "invalid_params", errors });
		const invalid = checkInput(input);
		if (invalid) return planFail(invalid);

		const { params, from, to } = input;
		const needed = candleTimeframes(params);
		// 候補が2つ以上なら、足りない銘柄が分かるよう銘柄を添える
		const named = (m: MarketData, message: string) =>
			markets.length > 1 ? `${m.instrument.symbol}: ${message}` : message;
		// 条件の足より細かいデータがあれば、条件の足は自動で作られている。
		// 銘柄ごとに同じ粒度の足で判定するので、銘柄の中で最も粗いものに合わせる
		let finest: Timeframe | null = null;
		for (const m of markets) {
			const own = m.importedTimeframes(from, to)[0];
			if (!own) {
				return planFail({
					kind: "no_data",
					message: named(
						m,
						"期間に取り込み済みのデータが無い。期間を変えるか、過去データを取り込む",
					),
				});
			}
			try {
				checkDataResolution(own, needed[0] ?? null);
			} catch (e) {
				if (e instanceof BacktestError) {
					return planFail({ kind: "no_data", message: named(m, e.message) });
				}
				throw e;
			}
			if (finest === null || isCoarser(own, finest)) finest = own;
		}
		if (finest === null) throw new Error("候補が無い");
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
		// 予定の前後の条件は、見る予定がすべてその版で判断済み（失敗して止めたものを除く）のときだけ実行する。
		// 未判断の予定は暦切れとして扱われ、成績の差が版の違いによるのか判断の進み具合によるのか分からないため
		const span = eventWindowHours(params);
		let eventCriteriaVersion: number | null = null;
		if (span) {
			const version = input.eventCriteriaVersion ?? calendar.activeVersion();
			const c =
				version === null
					? null
					: calendar.judgmentCoverage(
							from - span.afterHours * HOUR_MS,
							to + span.beforeHours * HOUR_MS,
							version,
						);
			if (version === null || c === null) {
				return planFail({
					kind: "invalid_input",
					field: "eventCriteriaVersion",
					message: "予定の評価基準の版が見つからない。選び直す",
				});
			}
			if (c.done + c.failed < c.total) {
				return planFail({
					kind: "missing_event_judgments",
					version,
					coverage: c,
					message: `予定の前後の条件で見る予定のうち ${c.total - c.done - c.failed} 件に v${version} の重要度の判断が無いため実行できない。判断がそろうと実行できる`,
				});
			}
			eventCriteriaVersion = version;
		}
		// 判定頻度が戦略の粒度より短ければ、細かい足で判定する
		const step = chooseStepTimeframe(params, finest);
		for (const m of markets) {
			const gaps = m.gaps(step.timeframe, from, to);
			if (gaps.length > 0 && !input.skipGaps) {
				return planFail({
					kind: "gaps",
					instrument: m.instrument.id,
					gaps: gaps.slice(0, MAX_GAPS),
					gapCount: gaps.length,
					missingBars: gaps.reduce((n, g) => n + g.missing, 0),
				});
			}
			// 足はまとめて実行するときに件数ぶん読むと重いので、実行を始めるときに読む
			if (m.countCandles(step.timeframe, from, to) === 0) {
				return planFail({
					kind: "no_data",
					message: named(m, "期間に足が無い"),
				});
			}
		}
		return {
			ok: true,
			plan: {
				input,
				markets,
				segment,
				finest,
				step,
				rule,
				usesJudgments,
				firstScoredAt,
				criteriaVersion,
				newsDelayMs,
				newsFrom,
				eventCriteriaVersion,
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
				markets,
				segment,
				finest,
				step,
				rule,
				usesJudgments,
				firstScoredAt,
				criteriaVersion,
				newsDelayMs,
				newsFrom,
				eventCriteriaVersion,
			} = planned.plan;
			const { params, from, to } = input;
			const needed = candleTimeframes(params);
			const needs = conditionStrategy.candleNeeds(params);
			const loaded: BacktestMarket[] = markets.map((m) => {
				const candles: Partial<Record<Timeframe, Candle[]>> = {};
				for (const tf of needed) {
					const history = needs[tf] ?? 1;
					candles[tf] = m.loadCandles(
						tf,
						from - history * TIMEFRAME_MS[tf],
						to,
					);
				}
				return {
					instrument: m.instrument,
					candles,
					stepCandles: m.loadCandles(step.timeframe, from, to),
				};
			});
			const [head, ...otherMarkets] = loaded as [
				BacktestMarket,
				...BacktestMarket[],
			];
			// 判定する時刻は、どれかの銘柄に足がある時刻
			const barCount = new Set(
				loaded.flatMap((m) => m.stepCandles.map((c) => c.time)),
			).size;

			const id = repo.create({
				name: input.name.trim(),
				instrument: head.instrument,
				instruments: loaded.map((m) => m.instrument),
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
				eventCriteriaVersion,
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
					instrument: head.instrument,
					params,
					candles: head.candles as Partial<Record<Timeframe, Candle[]>>,
					dataTimeframe: finest,
					stepCandles: head.stepCandles as Candle[],
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
					// 予定の前後の条件が無ければ暦は見ない
					events: calendar.calendar(eventCriteriaVersion ?? undefined),
					dvol: strategyDvol(dvol, params, from, to),
					otherMarkets,
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

		chart(id, timeframe, maxBars = MAX_CHART_BARS, instrument) {
			const run = repo.get(id);
			const target = instrument ?? run?.instrument.id;
			const market = marketData.find((m) => m.instrument.id === target);
			const chart = run && repo.chart(id, target);
			if (
				!chart ||
				!run ||
				!market ||
				!run.instruments.some((i) => i.id === target)
			)
				return { ok: false, kind: "not_found" };
			const count = market.countCandles(timeframe, run.from, run.to);
			if (count > maxBars) {
				return { ok: false, kind: "too_many", count, max: maxBars };
			}
			// チャートの足は画面で選んだ粒度で、期間の足をそのときのデータから読む。
			// データが消えていれば、結果に残した足（日足。戦略が足の粒度を持っていた頃の実行はその粒度）を出す
			const loaded = market.loadCandles(timeframe, run.from, run.to);
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
									market.instrument.id,
								)
							: null,
				},
			};
		},

		equity(id) {
			return repo.equity(id);
		},

		orders(id, filter, offset, limit, instrument) {
			const stored = repo.orders(id);
			const run = repo.get(id);
			if (!stored || !run) return null;
			const all = listed(stored, run).filter(
				(o) =>
					instrument === undefined ||
					(o.instrument ?? run.instrument.id) === instrument,
			);
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
			const run = repo.get(id);
			return stored && run
				? (listed(stored, run).find((o) => o.id === orderId) ?? null)
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
