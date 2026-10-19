// MCP の道具が返す値の形。画面と同じ表記・評価・成績の段階に揃える

import type {
	GradeBadgeValue,
	Judge,
	JudgmentValue,
	Position,
	StrategyWatch,
	Timeframe,
	WatchAction,
	WatchGroup,
	WatchWait,
} from "@trading-studio/core";
import {
	conditionScreenText,
	conditionSetScreenText,
	fewTradesNote,
	gradeMaxDrawdown,
	gradePnl,
	gradeProfitFactor,
	gradeWinRate,
	JUDGES,
	JUDGMENT_VALUE_LABELS,
	JUDGMENT_VALUES,
	LIVE_AVAILABLE,
	MARKET_REGIME_LABELS,
	nextMoves,
	TIMEFRAME_MS,
	unrealizedPnl,
} from "@trading-studio/core";
import type { BacktestRun } from "../backtests/types-domain";
import type {
	Dataset,
	DatasetRun,
	DatasetRunDetail,
} from "../datasets/types-domain";
import type {
	CurrentJudgment,
	JudgmentService,
} from "../judgments/types-domain";
import type { MarketBarsResult } from "../market/types-domain";
import type { NewsItem } from "../news/types-domain";
import { MOVE_LABELS } from "../scoring-analysis/accuracy-domain";
import type {
	AccuracySummaryResult,
	ArticleAccuracy,
} from "../scoring-analysis/types-domain";
import type { Segment } from "../segments/types-domain";
import type { StoredStrategy } from "../strategies/types-domain";
import type {
	AutoTradingStatus,
	StoredOrder,
	StrategyLock,
	StrategySummary,
	TradingPerformance,
} from "../trading/types-domain";

const JST_OFFSET_MS = 9 * 3_600_000;

/** エポックミリ秒を JST の ISO 8601 にする */
export const jst = (ms: number) =>
	new Date(ms + JST_OFFSET_MS).toISOString().replace(/(\.000)?Z$/, "+09:00");

/** ISO 8601（タイムゾーン付き）か YYYY-MM-DD（JST の 0:00）をエポックミリ秒にする。読めなければ null */
export function parseTime(s: string): number | null {
	if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
		const t = Date.parse(`${s}T00:00:00+09:00`);
		return Number.isNaN(t) ? null : t;
	}
	// タイムゾーンの無い日時は実行環境の TZ で読まれてしまうので受け付けない
	if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) return null;
	const t = Date.parse(s);
	return Number.isNaN(t) ? null : t;
}

export function strategyView(
	s: StoredStrategy,
	strategyLock: (id: number) => StrategyLock | null,
) {
	return {
		id: s.id,
		name: s.name,
		lock: strategyLock(s.id),
		updatedAt: jst(s.updatedAt),
		screenText: conditionSetScreenText(s.params).join("\n"),
		params: s.params,
	};
}

const gradeLabel = (g: GradeBadgeValue | null) => g?.label ?? null;

/** 画面の成績の横に出す5段階の評価と、取引が少ないときの注意。損益はガチホと比べるので、ガチホが分からなければ null */
export function grades(s: {
	pnlPercent: number | null;
	buyHoldPercent: number | null;
	idle: boolean;
	winRate: number | null;
	profitFactor: number | null;
	trades: number;
	maxDrawdownPercent: number;
}) {
	return {
		pnl: gradeLabel(gradePnl(s.pnlPercent, s.buyHoldPercent, s.idle)),
		winRate: gradeLabel(gradeWinRate(s.winRate)),
		profitFactor: gradeLabel(gradeProfitFactor(s.profitFactor, s.trades)),
		maxDrawdown: gradeMaxDrawdown(s.maxDrawdownPercent).label,
		note: fewTradesNote(s.trades),
	};
}

export function runView(r: BacktestRun) {
	const s = r.summary;
	return {
		id: r.id,
		name: r.name,
		status: r.status,
		progress: r.progress,
		from: jst(r.from),
		to: jst(r.to),
		stepTimeframe: r.stepTimeframe,
		stepLimited: r.stepLimited,
		initialCash: r.initialCash,
		fees: r.fees,
		criteriaVersion: r.criteriaVersion,
		// 記事を公開から何分後に使ったか。市場評価の条件が無い・公開時刻から使う前の実行は null
		newsDelayMinutes:
			r.newsDelayMs === null ? null : Math.round(r.newsDelayMs / 60_000),
		// 使ったニュースのデータの版。違えば使ったニュースが違う
		newsDataVersion: r.newsDataVersion === null ? null : jst(r.newsDataVersion),
		// 期間を相場データで選んだときの相場データと、そのときの相場
		segment: r.segment && {
			id: r.segment.id,
			regime: MARKET_REGIME_LABELS[r.segment.regime],
		},
		// データセット（相場データを束ねたもの）でまとめて実行したときの、まとめた実行（get_dataset_run）
		datasetRunId: r.datasetRunId,
		startedAt: jst(r.startedAt),
		summary: s && {
			...s,
			maxDrawdownFrom:
				s.maxDrawdownFrom === null ? null : jst(s.maxDrawdownFrom),
			maxDrawdownTo: s.maxDrawdownTo === null ? null : jst(s.maxDrawdownTo),
			averageHoldingHours:
				s.averageHoldingMs === null
					? null
					: Math.round((s.averageHoldingMs / 3_600_000) * 10) / 10,
			// ガチホを持たない古い実行は損益の評価が null（画面はチャートの足から求める）
			grades: grades({
				...s,
				buyHoldPercent: s.buyHoldPercent ?? null,
				idle: s.trades === 0 && s.openPositionQuantity === 0,
			}),
		},
		orderCount: r.orderCount,
		filledCount: r.filledCount,
		error: r.error,
	};
}

export function datasetView(s: Dataset) {
	return {
		id: s.id,
		name: s.name,
		segments: s.segments.map(segmentRef),
		// 保存した後に消えた相場データの数
		missing: s.missing,
	};
}

export function datasetRunView(r: DatasetRun | DatasetRunDetail) {
	return {
		id: r.id,
		name: r.name,
		dataset: { id: r.datasetId, name: r.datasetName },
		status: r.status,
		progress: r.progress,
		initialCash: r.initialCash,
		fees: r.fees,
		criteriaVersion: r.criteriaVersion,
		startedAt: jst(r.startedAt),
		// 全取引をまとめた勝率・PF、損益率の平均・最悪、最大DDの最大、ガチホ以上だった件数、相場ごとの平均
		summary: r.summary && {
			...r.summary,
			byRegime: r.summary.byRegime.map((x) => ({
				...x,
				regime: MARKET_REGIME_LABELS[x.regime],
			})),
			// 損益の評価は損益率の平均をガチホの平均と比べる（画面の「損益の平均」）
			grades: grades({
				...r.summary,
				pnlPercent: r.summary.averagePnlPercent,
				buyHoldPercent: r.summary.averageBuyHoldPercent,
			}),
		},
		error: r.error,
		runs: "runs" in r ? r.runs.map(runView) : undefined,
	};
}

/** 画面と同じ評価の日本語名を添える */
const level = <J extends Judge>(value: JudgmentValue<J>) => ({
	value,
	label: JUDGMENT_VALUE_LABELS[value] ?? value,
});

const ratio = (v: number) => Math.round(v * 1000) / 1000;

export function newsView(
	n: NewsItem,
	weight: number | undefined,
	accuracy: ArticleAccuracy | undefined,
) {
	const s = n.score;
	const done = s?.status === "done";
	return {
		id: n.id,
		source: n.sourceName,
		language: n.language,
		title: n.title,
		summary: n.summary,
		url: n.url,
		publishedAt: jst(n.publishedAt),
		fetchedAt: jst(n.fetchedAt),
		status: s?.status ?? "unscored",
		scores: done ? s.scores : null,
		duration: done ? s.duration : null,
		comment: s?.comment ?? null,
		scoredAt: s?.scoredAt == null ? null : jst(s.scoredAt),
		rescoredAt: s?.rescoredAt == null ? null : jst(s.rescoredAt),
		criteriaVersion: s?.criteriaVersion ?? null,
		model: s?.model ?? null,
		appVersion: s?.appBuiltAt == null ? null : jst(s.appBuiltAt),
		error: s?.error ?? null,
		nextAttemptAt: s?.nextAttemptAt == null ? null : jst(s.nextAttemptAt),
		weight: done ? ratio(weight ?? 0) : null,
		precision:
			accuracy === undefined
				? null
				: accuracy.status === "ok"
					? { sentiment: accuracy.sentiment, risk: accuracy.risk }
					: accuracy.status,
		rescore: n.rescore && {
			...n.rescore,
			nextAttemptAt:
				n.rescore.nextAttemptAt === null ? null : jst(n.rescore.nextAttemptAt),
		},
	};
}

/** 市場評価の分析の観点1つ。画面の 精度ごと・評価ごと・評価×値動き と同じ数 */
export function analysisView<J extends Judge>(
	j: J,
	r: AccuracySummaryResult<J>,
) {
	const values = JUDGMENT_VALUES[j] as readonly JudgmentValue<J>[];
	return {
		count: r.count,
		byPrecision: r.rows.map((row) => ({
			precision: row.precision,
			count: row.count,
			byLevel: row.levels.map((l) => ({ ...level(l.value), count: l.count })),
		})),
		byLevel: values.map((value) => {
			const counts = r.rows.map((row) => ({
				precision: row.precision,
				count: row.levels.find((l) => l.value === value)?.count ?? 0,
			}));
			const n = counts.reduce((a, x) => a + x.count, 0);
			return {
				...level(value),
				count: n,
				byPrecision: counts,
			};
		}),
		byLevelAndMove: r.matrix.map((m) => ({
			...level(m.value),
			moves: m.moves.map((count, i) => ({ move: MOVE_LABELS[j][i], count })),
		})),
	};
}

const MODE_LABELS = { paper: "デモ", live: "リアル" } as const;

/** 口座・成績・注文・戦略の見張りを出さない戦略。画面と同じく、動かせないリアル */
export const hidden = (r: AutoTradingStatus) =>
	r.mode === "live" && !LIVE_AVAILABLE;

function positionView(p: Position) {
	return { ...p, openedAt: p.openedAt === null ? null : jst(p.openedAt) };
}

export function tradingPerformanceView(p: TradingPerformance) {
	return {
		...p,
		resetAt: jst(p.resetAt),
		position: positionView(p.position),
		maxDrawdownFrom: p.maxDrawdownFrom === null ? null : jst(p.maxDrawdownFrom),
		maxDrawdownTo: p.maxDrawdownTo === null ? null : jst(p.maxDrawdownTo),
		averageHoldingHours:
			p.averageHoldingMs === null
				? null
				: Math.round((p.averageHoldingMs / 3_600_000) * 10) / 10,
		grades: grades({
			...p,
			idle: p.trades === 0 && p.position.quantity === 0,
		}),
	};
}

export function tradingRunView(r: AutoTradingStatus) {
	return {
		id: r.id,
		name: r.name,
		mode: r.mode,
		modeLabel: MODE_LABELS[r.mode],
		enabled: r.enabled,
		nextEvalAt: r.nextEvalAt === null ? null : jst(r.nextEvalAt),
		startedAt: r.startedAt === null ? null : jst(r.startedAt),
		// 口座をリセットしてから一度もオンにしていなければ false（戦略の一覧の「まだ動かしていない」）
		ranSinceReset: r.ranSinceReset,
		waitingForMarket: r.waitingForMarket,
		dailyLoss: r.dailyLoss,
	};
}

/** デモの口座・含み損益・成績。リアルは画面と同じく出さない */
export function paperView(
	r: AutoTradingStatus,
	price: number | null,
	performance: TradingPerformance | null,
) {
	const a = r.account;
	return {
		account: {
			initialCash: a.initialCash,
			cash: a.cash,
			equity: a.equity,
			position: positionView(a.position),
			lots: a.lots.map((l) => ({
				...l,
				openedAt: jst(l.openedAt),
				unrealizedPnl: unrealizedPnl(l.quantity, l.entryPrice, price),
			})),
			openOrderCount: a.openOrderCount,
			resetAt: jst(a.resetAt),
		},
		unrealizedPnl: unrealizedPnl(
			a.position.quantity,
			a.position.entryPrice,
			price,
		),
		performance: performance && tradingPerformanceView(performance),
	};
}

export function tradingOrderView(o: StoredOrder) {
	return {
		id: o.id,
		side: o.side,
		type: o.type,
		price: o.price,
		quantity: o.quantity,
		status: o.status,
		placedAt: jst(o.placedAt),
		filledAt: o.filledAt === null ? null : jst(o.filledAt),
		fillPrice: o.fillPrice,
		fee: o.fee,
		canceledAt: o.canceledAt === null ? null : jst(o.canceledAt),
		cancelReason: o.cancelReason,
		reason: o.reason,
		pnl: o.pnl,
		lotPrice: o.lotPrice,
		exitKind: o.exitKind,
		buyName: o.buyName ?? null,
		strategyName: o.strategyName,
	};
}

/** 発注したときの市場評価。判断の記録が無ければ null、採点の記録の前は空 */
export function judgmentsView(j: Record<string, string> | undefined) {
	if (!j) return null;
	return Object.fromEntries(
		JUDGES.filter((k) => j[k] !== undefined).map((k) => [
			k,
			level(j[k] as JudgmentValue<typeof k>),
		]),
	);
}

/** 条件は画面の文言にする */
export function watchGroupView(g: WatchGroup) {
	return {
		match: g.match,
		met: g.met,
		triggers: g.triggers,
		conditions: g.conditions.map((c) => ({
			text: conditionScreenText(c.condition),
			met: c.met,
			detail: c.detail,
			edge: c.edge,
		})),
	};
}

/** 発動価格の今の価格からの幅（%）を足す。次の判定で起きるもの（価格なし）は null */
const withDistance = (price: number) => (a: WatchAction) => ({
	...a,
	distancePercent:
		a.price === null ? null : Math.round((a.price / price - 1) * 10_000) / 100,
});

/** 価格で起きない理由。揃えば届く価格に今の価格からの幅（%）を足す */
const waitView = (price: number) => (w: WatchWait) =>
	w.reason.kind === "conditions"
		? {
				...w,
				reason: {
					...w.reason,
					conditions: w.reason.conditions.map((c) => ({
						text: conditionScreenText(c.condition),
						detail: c.detail,
					})),
					atDistancePercent:
						typeof w.reason.at === "number"
							? Math.round((w.reason.at / price - 1) * 10_000) / 100
							: null,
				},
			}
		: w;

/** ホームのカード1枚ぶん。比べる値（通算損益・含み損益・確定損益・勝率・PF・最大DD・取引回数）と次の動き */
export function strategySummaryView(s: StrategySummary) {
	const { position, lots } = s.status.account;
	const n = s.nextMoves;
	const action = n && withDistance(n.price);
	return {
		...tradingRunView(s.status),
		performance: s.performance && tradingPerformanceView(s.performance),
		unrealizedPnl: unrealizedPnl(
			position.quantity,
			position.entryPrice,
			n?.price ?? s.performance?.price ?? null,
		),
		lots: lots.length,
		nextMoves: n &&
			action && {
				now: n.now.map(action),
				up: n.up && action(n.up),
				down: n.down && action(n.down),
				waits: n.waits.map(waitView(n.price)),
			},
	};
}

export function watchView(w: StrategyWatch) {
	const action = withDistance(w.price);
	const next = nextMoves(w);
	return {
		price: w.price,
		nextMoves: {
			now: next.now.map(action),
			up: next.up && action(next.up),
			down: next.down && action(next.down),
			waits: next.waits.map(waitView(w.price)),
		},
		actions: w.actions.map(action),
		buys: w.buys.map((b) => ({
			...b,
			buy: watchGroupView(b.buy),
			lots: b.lots.map((l) => ({
				...l,
				groups:
					l.groups &&
					Object.fromEntries(
						Object.entries(l.groups).map(([k, g]) => [
							k,
							g && watchGroupView(g),
						]),
					),
			})),
		})),
	};
}

/** 相場データを指すときの短い形 */
export function segmentRef(d: Segment) {
	return {
		id: d.id,
		from: jst(d.from),
		to: jst(d.to),
		regime: MARKET_REGIME_LABELS[d.regime],
	};
}

/** list_segments の1件。騰落率と変動の大きさを % で */
export function segmentView(d: Segment) {
	return {
		id: d.id,
		from: jst(d.from),
		to: jst(d.to),
		regime: d.regime,
		label: MARKET_REGIME_LABELS[d.regime],
		returnPercent: d.returnPpm / 10_000,
		volatilityPercent: d.volatilityPpm / 10_000,
	};
}

/** 戦略の条件を画面と同じ文で添えた、バックテスト1件 */
export function runDetailView(r: BacktestRun) {
	return {
		...runView(r),
		screenText: conditionSetScreenText(r.params).join("\n"),
		params: r.params,
	};
}

/** 戦略の条件を画面と同じ文で添えた、まとめた実行1件 */
export function datasetRunDetailView(r: DatasetRunDetail) {
	return {
		...datasetRunView(r),
		screenText: conditionSetScreenText(r.params).join("\n"),
		params: r.params,
	};
}

/** 観点ごとの今の市場評価 */
export function resultsView(c: Pick<CurrentJudgment, "results">) {
	return Object.fromEntries(
		JUDGES.map((j) => {
			const r = c.results[j];
			return [j, { ...level(r.value), average: r.average, count: r.count }];
		}),
	);
}

/** 市場評価と、記事の点数の段階ごとの内訳 */
export function evaluationView(c: CurrentJudgment) {
	return {
		time: jst(c.time),
		firstScoredAt: c.firstScoredAt === null ? null : jst(c.firstScoredAt),
		results: resultsView(c),
		breakdown: Object.fromEntries(
			JUDGES.map((j) => [
				j,
				c.breakdown[j].map((row) => ({
					...level(row.value),
					count: row.count,
					average: row.average,
					weightShare: ratio(row.share),
				})),
			]),
		),
		note: "breakdown は評価基準の上の段階から順。weightShare は重みの合計に占める割合（0〜1）。段階ごとの average × weightShare の和が全体の average になる",
	};
}

/** 新しいほうから limit 本の足（古い順）と、足ごとの市場評価（チャートの背景） */
export function barsView(
	all: Extract<MarketBarsResult, { ok: true }>["bars"],
	limit: number,
	timeframe: Timeframe,
	judgments: Pick<JudgmentService, "series">,
) {
	const bars = all.slice(-limit);
	const first = bars[0];
	const last = bars.at(-1);
	if (!first || !last) return { total: 0, bars: [] };
	const step = TIMEFRAME_MS[timeframe];
	const series = judgments.series(first.time, last.time + step, step);
	const at = (j: Judge, time: number) => {
		const v = series.values[j][Math.floor((time - series.from) / step)];
		return v == null ? null : level(v);
	};
	return {
		total: all.length,
		firstScoredAt:
			series.firstScoredAt === null ? null : jst(series.firstScoredAt),
		bars: bars.map((b) => ({
			...b,
			time: jst(b.time),
			marketEvaluation: {
				sentiment: at("sentiment", b.time),
				risk: at("risk", b.time),
			},
		})),
	};
}
