// バックテストエンジン。過去の足の上で戦略を動かし、注文・約定・成績を計算する

import { aggregateCandles } from "./candles";
import type { DvolPoint } from "./dvol";
import type { EventCalendar } from "./event-calendar";
import { HOUR_MS } from "./event-calendar";
import type { Instrument } from "./instrument";
import { marketOf } from "./instrument";
import { notional } from "./money";
import type { AggregationRule, ScoredNews } from "./news-judgment";
import { judgmentCursor, scoredNewsFor } from "./news-judgment";
import type { Strategy } from "./strategy";
import type { Timeframe } from "./timeframe";
import {
	candleStart,
	isCoarser,
	TIMEFRAME_LABELS,
	TIMEFRAME_MS,
} from "./timeframe";
import type { DecisionLog, FeeRates, Trade, TradeOrder } from "./trading";
import {
	cancelAll,
	decideAll,
	expireOrders,
	newAccount,
	settleFills,
} from "./trading";
import type { Candle, JsonValue, Order } from "./types";

/** 約定のルール。約定するなら約定価格、しなければ null を返す。差し替えられるようにする */
export type FillModel = (
	order: Order,
	bar: Candle,
	instrument: Instrument,
) => number | null;

/**
 * 成行は次の足の始値から、買値と売値の差の半分だけ不利にずらした価格（ADR 0037。足は売買の中間の値とみなす）、
 * 指値は足の値幅が指値に届いたら指値で約定する
 */
export const defaultFillModel: FillModel = (order, bar, instrument) => {
	if (order.type === "market") {
		const half = Math.ceil((bar.open * instrument.spreadPpm) / 2_000_000);
		return order.side === "buy" ? bar.open + half : bar.open - half;
	}
	const price = order.price as number;
	if (order.side === "buy") {
		return bar.low <= price ? price : null;
	}
	return bar.high >= price ? price : null;
};

/** 候補の銘柄1つぶんの足 */
export type BacktestMarket = {
	instrument: Instrument;
	/** 戦略が頼む粒度ごとの足（古い順）。期間より前の足も含めてよい（指標の計算に使う） */
	candles: Readonly<Partial<Record<Timeframe, readonly Candle[]>>>;
	/** 判定と約定に使う足（古い順、期間内）。粒度は stepTimeframe */
	stepCandles: readonly Candle[];
};

export type BacktestConfig<P> = {
	/** 候補の先頭の銘柄 */
	instrument: Instrument;
	strategy: Strategy<P>;
	params: P;
	/** 戦略が頼む粒度ごとの足（古い順）。期間より前の足も含めてよい（指標の計算に使う） */
	candles: Readonly<Partial<Record<Timeframe, readonly Candle[]>>>;
	/** 候補の2つ目以降の銘柄（ADR 0037）。先頭の銘柄と同じ市場・同じ判定に使う足の粒度 */
	otherMarkets?: readonly BacktestMarket[];
	/** 取り込まれているデータのうち最も細かい粒度。戦略が頼む粒度より粗ければ実行しない */
	dataTimeframe: Timeframe;
	/** 判定と約定に使う足（古い順、期間内）と粒度。戦略が頼む粒度の途中の足をこの足から組み立てるため、それより細かいか同じにする */
	stepCandles: readonly Candle[];
	stepTimeframe: Timeframe;
	/** 期間。開始時刻が from 以上 to 未満の足で売買する */
	from: number;
	to: number;
	initialCash: number;
	fees: FeeRates;
	fillModel?: FillModel;
	/** 進捗の通知。処理した足の本数と、期間内の足の本数 */
	onProgress?: (done: number, total: number) => void;
	/** true を返すと中止する */
	shouldAbort?: () => boolean;
	/**
	 * AI 判定の材料。評価のたびに、その時刻までに採点済みの点数からこのルールで判定を作って戦略へ渡す。
	 * 戦略が判定器を使わなければ省いてよい。
	 * since は採点の記録が始まった時刻で、これより前（null なら全体）は判定を渡さない（データなし）
	 */
	/** 予定の暦 */
	events: EventCalendar;
	/** DVOL の1時間足（古い順）。期間より前も戦略の dvolMs の分だけ含める。DVOL の条件が無ければ空でよい */
	dvol: readonly DvolPoint[];
	judgments?: {
		news: readonly ScoredNews[];
		rule: AggregationRule;
		since?: number | null;
	};
};

export class BacktestError extends Error {
	override name = "BacktestError";
}

export class BacktestAborted extends Error {
	override name = "BacktestAborted";
}

/** バックテストの注文の記録。全モード共通の TradeOrder と同じ */
export type BacktestOrder = TradeOrder;

export type BacktestSummary = {
	initialCash: number;
	/** 最終資金。未決済のポジションは最後の足の終値で評価する */
	finalEquity: number;
	pnl: number;
	pnlPercent: number;
	/** 往復の回数（未決済は含めない） */
	trades: number;
	wins: number;
	losses: number;
	/** 勝率（%）。取引が無ければ null */
	winRate: number | null;
	/** 損益比率。損失が 0 なら null */
	profitFactor: number | null;
	/** 最大ドローダウン（%、0 以上） */
	maxDrawdownPercent: number;
	maxDrawdownFrom: number | null;
	maxDrawdownTo: number | null;
	/** 期間の最初の足の始値から最後の足の終値まで、ただ持っていた場合の損益率（%）。持たない結果は null として読む */
	buyHoldPercent?: number;
	/** 平均保有期間（ミリ秒）。取引が無ければ null */
	averageHoldingMs: number | null;
	/** 期間の最後に持っていた、候補の先頭の銘柄の数量（数量の最小単位） */
	openPositionQuantity: number;
	/** 銘柄ごとの成績（ADR 0037）。候補が2つ以上の実行だけ持つ。銘柄の id ごと、候補の並び順 */
	byInstrument?: Record<string, InstrumentSummary>;
};

/**
 * 1銘柄の成績。資金は銘柄で共有するので、元手に対する率と最大ドローダウンは持たない。
 * pnl は確定した往復の損益と、期間の最後に持っていたロットの評価損益（最後の足の終値で評価）の和。全銘柄の和が全体の損益になる
 */
export type InstrumentSummary = {
	pnl: number;
	trades: number;
	wins: number;
	losses: number;
	winRate: number | null;
	profitFactor: number | null;
	averageHoldingMs: number | null;
	/** 期間の最初の足の始値から最後の足の終値まで、この銘柄だけを持っていた場合の損益率（%）。期間に足が無ければ null */
	buyHoldPercent: number | null;
	/** 期間の最後に持っていた数量（数量の最小単位） */
	openPositionQuantity: number;
};

/** 往復の一覧から勝ち負けの集計を出す */
function tradeStats(trades: readonly Trade[]) {
	const wins = trades.filter((t) => t.pnl > 0);
	const losses = trades.filter((t) => t.pnl <= 0);
	const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
	const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
	return {
		trades: trades.length,
		wins: wins.length,
		losses: losses.length,
		winRate: trades.length ? (wins.length / trades.length) * 100 : null,
		profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
		averageHoldingMs: trades.length
			? trades.reduce((a, t) => a + (t.exitTime - t.entryTime), 0) /
				trades.length
			: null,
	};
}

export type BacktestResult = {
	summary: BacktestSummary;
	orders: BacktestOrder[];
	trades: Trade[];
	decisions: DecisionLog[];
	/** 期間内の日足（判定に使った足から作る。チャートの元の足が無いときに使う）。候補の先頭の銘柄 */
	candles: Candle[];
	/** 候補の2つ目以降の銘柄の期間内の日足。銘柄の id ごと */
	otherCandles?: Record<string, Candle[]>;
	/** 候補が2つ以上のときの総資産（未決済は終値で評価）の日足。終値がその日の最後の判定の総資産 */
	equity?: Candle[];
};

/** データが条件で使う足より粗ければエラーにする（日足では1時間足の条件を検証できないため） */
export function checkDataResolution(
	dataTimeframe: Timeframe,
	needed: Timeframe | null,
): void {
	if (needed !== null && isCoarser(dataTimeframe, needed)) {
		throw new BacktestError(
			`取り込み済みのデータは${TIMEFRAME_LABELS[dataTimeframe]}までで、条件で使う${TIMEFRAME_LABELS[needed]}より粗いため実行できない`,
		);
	}
}

export function runBacktest<P>(config: BacktestConfig<P>): BacktestResult {
	const {
		strategy,
		params,
		from,
		to,
		initialCash,
		fees,
		fillModel = defaultFillModel,
		onProgress,
		shouldAbort,
	} = config;
	const needs = strategy.candleNeeds(params);
	const timeframes = (Object.keys(needs) as Timeframe[]).sort(
		(x, y) => TIMEFRAME_MS[x] - TIMEFRAME_MS[y],
	);
	checkDataResolution(config.dataTimeframe, timeframes[0] ?? null);
	const { calendar } = marketOf(config.instrument);
	const stepTimeframe = config.stepTimeframe;
	if (timeframes.some((t) => isCoarser(stepTimeframe, t))) {
		throw new BacktestError("判定に使う足が条件で使う足より粗い");
	}
	const stepMs = TIMEFRAME_MS[stepTimeframe];
	// 直近の細かい足として、判定に使う足をこの本数だけ渡す
	const recentBars = Math.ceil(strategy.recentMs(params) / stepMs) + 1;
	const dvolMs = strategy.dvolMs(params);
	// 判定の時刻までに確定した DVOL の足の数（先頭から）と、渡す範囲の先頭
	let dvolDone = 0;
	let dvolFrom = 0;
	const dvolAt = (now: number): readonly DvolPoint[] => {
		if (dvolMs === 0) return [];
		const all = config.dvol;
		while (
			dvolDone < all.length &&
			(all[dvolDone] as DvolPoint).time + HOUR_MS <= now
		) {
			dvolDone++;
		}
		while (
			dvolFrom < dvolDone &&
			(all[dvolFrom] as DvolPoint).time + HOUR_MS <= now - dvolMs
		) {
			dvolFrom++;
		}
		return all.slice(dvolFrom, dvolDone);
	};
	const judges = strategy.requiredJudges(params);
	if (judges.length > 0 && !config.judgments) {
		throw new BacktestError(
			"AI 判定の条件があるのに、判定の材料が渡されていない",
		);
	}
	// 銘柄ごとの評価で判定する（ADR 0037）。時刻を昇順に進めるので銘柄ごとに持つ
	const cursors = new Map<string, ReturnType<typeof judgmentCursor>>();
	const cursorOf = (instrument: string) => {
		const material = config.judgments;
		if (judges.length === 0 || !material) return null;
		let c = cursors.get(instrument);
		if (!c) {
			c = judgmentCursor(
				scoredNewsFor(material.news, instrument),
				material.rule,
			);
			cursors.set(instrument, c);
		}
		return c;
	};
	const since = config.judgments?.since;
	const judgmentsAt = (instrument: string, time: number) => {
		const judgeAtTime = cursorOf(instrument);
		if (!judgeAtTime) return {};
		if (since === null || (since !== undefined && time < since)) return {};
		const v = judgeAtTime(time);
		return Object.fromEntries(
			judges.map((j) => [
				j,
				[{ judge: j, time, label: v[j as keyof typeof v] }],
			]),
		);
	};

	const primary = config.instrument.id;
	const invalid = strategy.validateCandidates?.(params, [
		config.instrument,
		...(config.otherMarkets ?? []).map((m) => m.instrument),
	]);
	if (invalid?.length) {
		throw new BacktestError(invalid.map((e) => e.message).join("。"));
	}
	const markets = [
		{
			instrument: config.instrument,
			candles: config.candles,
			stepCandles: config.stepCandles,
		},
		...(config.otherMarkets ?? []),
	].map((m) => {
		const steps = m.stepCandles;
		const startIndex = steps.findIndex((c) => c.time >= from);
		const endIndex = steps.findLastIndex((c) => c.time < to);
		return {
			instrument: m.instrument,
			steps,
			startIndex,
			endIndex,
			/** 次に見る判定に使う足の位置と、最後に見た足の位置（まだ無ければ -1） */
			next: startIndex,
			current: -1,
			// 粒度ごとの、判定時点で確定している足の数（その粒度の足の先頭から）と、細かい足から組み立てる途中の足
			series: timeframes.map((timeframe) => ({
				timeframe,
				all: m.candles[timeframe] ?? [],
				history: Math.max(1, needs[timeframe] ?? 1),
				completed: 0,
				forming: null as Candle | null,
			})),
			state: null as JsonValue,
			nextEvalAt: Number.NEGATIVE_INFINITY,
		};
	});
	type Market = (typeof markets)[number];
	const head = markets[0] as Market;
	if (head.startIndex < 0 || head.endIndex < head.startIndex) {
		throw new BacktestError("期間に足が無い");
	}
	const inRangeOf = (m: Market) =>
		m.startIndex < 0 || m.endIndex < m.startIndex
			? []
			: m.steps.slice(m.startIndex, m.endIndex + 1);
	// 判定の時刻は、どれかの銘柄に判定に使う足がある時刻（銘柄ごとの欠損では止めない）
	const times = [
		...new Set(markets.flatMap((m) => inRangeOf(m).map((c) => c.time))),
	].sort((a, b) => a - b);
	const total = times.length;

	let account = newAccount(initialCash);
	// 注文の記録。id で最新の内容に置き換える（Map は最初に入れた順を保つので発注順になる）
	const orders = new Map<string, TradeOrder>();
	const trades: Trade[] = [];
	const decisions: DecisionLog[] = [];
	const equityOf = () =>
		account.cash +
		markets.reduce((a, m) => {
			const bar = m.steps[m.current];
			if (!bar) return a;
			const quantity = account.lots
				.filter((l) => (l.instrument ?? primary) === m.instrument.id)
				.reduce((q, l) => q + l.quantity, 0);
			return a + notional(m.instrument, bar.close, quantity, "floor");
		}, 0);

	// 候補が2つ以上のときの足ごとの総資産（日足にまとめて結果に残す）
	const equities: Candle[] = [];
	let peak = initialCash;
	let peakAt = times[0] ?? from;
	let maxDd = 0;
	let ddFrom: number | null = null;
	let ddTo: number | null = null;

	for (let k = 0; k < times.length; k++) {
		if (shouldAbort?.()) {
			throw new BacktestAborted("中止した");
		}
		const time = times[k] as number;
		const closeAt = time + stepMs;
		const filled = new Set<Market>();

		// 足の中の約定 → 足の終わりに期限切れの取消 → 判定
		for (const m of markets) {
			const bar = m.steps[m.next];
			if (!bar || m.next > m.endIndex || bar.time !== time) continue;
			m.current = m.next++;
			for (const x of m.series) {
				const barStart = candleStart(bar.time, x.timeframe, calendar);
				const prev = x.forming;
				x.forming =
					prev?.time === barStart
						? {
								time: barStart,
								open: prev.open,
								high: Math.max(prev.high, bar.high),
								low: Math.min(prev.low, bar.low),
								close: bar.close,
								volume: prev.volume + bar.volume,
							}
						: { ...bar, time: barStart };
			}
			const settled = settleFills(
				account,
				(order) => fillModel(order, bar, m.instrument),
				bar.time,
				fees,
				m.instrument,
				calendar,
				primary,
			);
			account = settled.account;
			for (const r of settled.changed) orders.set(r.id, r);
			trades.push(...settled.trades);
			if (settled.filled) filled.add(m);
		}
		const expired = expireOrders(
			account,
			closeAt,
			markets.map((m) => m.instrument) as [Instrument, ...Instrument[]],
		);
		account = expired.account;
		for (const r of expired.changed) orders.set(r.id, r);

		const due = markets.filter(
			(m) => m.current >= 0 && (filled.has(m) || closeAt >= m.nextEvalAt),
		);
		if (due.length > 0) {
			const dvol = dvolAt(closeAt);
			const out = decideAll({
				strategy,
				params,
				now: closeAt,
				events: config.events,
				account,
				fees,
				primary,
				quotes: markets
					.filter((m) => m.current >= 0)
					.map((m) => ({
						instrument: m.instrument,
						price: (m.steps[m.current] as Candle).close,
					})),
				markets: due.map((m) => {
					const bar = m.steps[m.current] as Candle;
					const candles: Partial<Record<Timeframe, readonly Candle[]>> = {};
					for (const x of m.series) {
						const current = x.forming as Candle;
						while (
							x.completed < x.all.length &&
							(x.all[x.completed] as Candle).time < current.time
						) {
							x.completed++;
						}
						// 確定した足に、途中の足（今の足）を足して渡す。判定に使う足と同じ粒度なら今の足そのもの
						candles[x.timeframe] = [
							...x.all.slice(
								Math.max(0, x.completed - (x.history - 1)),
								x.completed,
							),
							current,
						];
					}
					return {
						instrument: m.instrument,
						price: bar.close,
						candles,
						recent: {
							timeframeMs: stepMs,
							candles: m.steps.slice(
								Math.max(0, m.current + 1 - recentBars),
								m.current + 1,
							),
						},
						judgments: judgmentsAt(m.instrument.id, closeAt),
						dvol,
						state: m.state,
					};
				}),
			});
			account = out.account;
			for (const r of out.changed) orders.set(r.id, r);
			out.results.forEach((r, i) => {
				const m = due[i] as Market;
				m.state = r.state;
				m.nextEvalAt = r.nextEvalAt;
				decisions.push(r.decision);
			});
		}

		// 足ごとの時価評価でドローダウンを測る
		const equity = equityOf();
		if (markets.length > 1) {
			equities.push({
				time,
				open: equity,
				high: equity,
				low: equity,
				close: equity,
				volume: 0,
			});
		}
		if (equity > peak) {
			peak = equity;
			peakAt = closeAt;
		}
		const dd = peak > 0 ? (peak - equity) / peak : 0;
		if (dd > maxDd) {
			maxDd = dd;
			ddFrom = peakAt;
			ddTo = closeAt;
		}

		const done = k + 1;
		if (onProgress && (done % 1000 === 0 || done === total)) {
			onProgress(done, total);
		}
	}

	const lastTime = times.at(-1) as number;
	for (const r of cancelAll(
		account,
		lastTime + stepMs,
		"期間の終わりまで約定しなかった",
	).changed) {
		orders.set(r.id, r);
	}
	const finalEquity = equityOf();
	const buyHoldOf = (m: Market) => {
		const c = inRangeOf(m);
		return c.length > 0
			? ((c.at(-1) as Candle).close / (c[0] as Candle).open - 1) * 100
			: null;
	};
	// ただ持っていた場合は、期間に足のある銘柄に等分したものとする
	const holds = markets.map(buyHoldOf).filter((x) => x !== null);
	const others = markets.slice(1);
	const instrumentOf = (x: { instrument?: string }) => x.instrument ?? primary;
	const summaryOf = (m: Market): InstrumentSummary => {
		const id = m.instrument.id;
		const own = trades.filter((t) => instrumentOf(t) === id);
		const lots = account.lots.filter((l) => instrumentOf(l) === id);
		const bar = m.steps[m.current];
		const quantity = lots.reduce((q, l) => q + l.quantity, 0);
		// 全体の時価と同じく、数量の合計を1回だけ切り捨てて評価する（ロットごとに切り捨てると和がずれる）
		const unrealized =
			(bar ? notional(m.instrument, bar.close, quantity, "floor") : 0) -
			lots.reduce((a, l) => a + l.cost - (l.realizedPnl ?? 0), 0);
		return {
			pnl: own.reduce((a, t) => a + t.pnl, 0) + unrealized,
			...tradeStats(own),
			buyHoldPercent: buyHoldOf(m),
			openPositionQuantity: quantity,
		};
	};

	return {
		summary: {
			initialCash,
			finalEquity,
			pnl: finalEquity - initialCash,
			pnlPercent: ((finalEquity - initialCash) / initialCash) * 100,
			...tradeStats(trades),
			maxDrawdownPercent: maxDd * 100,
			maxDrawdownFrom: ddFrom,
			maxDrawdownTo: ddTo,
			openPositionQuantity: account.lots
				.filter((l) => instrumentOf(l) === primary)
				.reduce((q, l) => q + l.quantity, 0),
			buyHoldPercent: holds.reduce((a, x) => a + x, 0) / holds.length,
			...(others.length > 0
				? {
						byInstrument: Object.fromEntries(
							markets.map((m) => [m.instrument.id, summaryOf(m)]),
						),
					}
				: {}),
		},
		orders: [...orders.values()],
		trades,
		decisions,
		candles: aggregateCandles(inRangeOf(head), "1d", calendar),
		...(others.length > 0
			? {
					otherCandles: Object.fromEntries(
						others.map((m) => [
							m.instrument.id,
							aggregateCandles(inRangeOf(m), "1d", calendar),
						]),
					),
					equity: aggregateCandles(equities, "1d", calendar),
				}
			: {}),
	};
}
