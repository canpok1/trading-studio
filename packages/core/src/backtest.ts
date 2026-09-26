// バックテストエンジン。過去の足の上で戦略を動かし、注文・約定・成績を計算する

import { formatBtc, formatYen } from "./format";
import { feeYen, notionalYen, PPM, SATOSHI_PER_BTC } from "./money";
import type { AggregationRule, ScoredNews } from "./news-judgment";
import { judgmentCursor } from "./news-judgment";
import type { Strategy, StrategyOutput } from "./strategy";
import type { Timeframe } from "./timeframe";
import {
	candleStart,
	isCoarser,
	TIMEFRAME_LABELS,
	TIMEFRAME_MS,
} from "./timeframe";
import type {
	Candle,
	JsonValue,
	Order,
	OrderIntent,
	OrderType,
	Position,
	Side,
} from "./types";
import { EMPTY_POSITION } from "./types";

/** 手数料率（ppm） */
export type FeeRates = { limitPpm: number; marketPpm: number };

/** 既定の手数料率。どちらも 0.1%（Coincheck の実際の率は未確認の仮置き） */
export const DEFAULT_FEE_RATES: FeeRates = { limitPpm: 1000, marketPpm: 1000 };

/** 約定のルール。約定するなら約定価格、しなければ null を返す。差し替えられるようにする */
export type FillModel = (order: Order, bar: Candle) => number | null;

/** 成行は次の足の始値、指値は足の値幅が指値に届いたら指値で約定する */
export const defaultFillModel: FillModel = (order, bar) => {
	if (order.type === "market") {
		return bar.open;
	}
	const price = order.price as number;
	if (order.side === "buy") {
		return bar.low <= price ? price : null;
	}
	return bar.high >= price ? price : null;
};

export type BacktestConfig<P> = {
	strategy: Strategy<P>;
	params: P;
	/** 戦略の粒度の足（古い順）。期間より前の足も含めてよい（指標の計算に使う） */
	candles: readonly Candle[];
	/** 取り込まれているデータのうち最も細かい粒度。戦略の粒度より粗ければ実行しない */
	dataTimeframe: Timeframe;
	/**
	 * 判定と約定に使う足（古い順、期間内）と粒度。判定頻度が戦略の粒度より短いとき、戦略の粒度より細かい足を渡す。
	 * 省略すると戦略の粒度の足で進める
	 */
	stepCandles?: readonly Candle[];
	stepTimeframe?: Timeframe;
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
	 * 戦略が判定器を使わなければ省いてよい
	 */
	judgments?: { news: readonly ScoredNews[]; rule: AggregationRule };
};

export class BacktestError extends Error {
	override name = "BacktestError";
}

export class BacktestAborted extends Error {
	override name = "BacktestAborted";
}

export type BacktestOrder = {
	id: string;
	side: Side;
	type: OrderType;
	/** 指値の価格。成行は null */
	price: number | null;
	quantity: number;
	placedAt: number;
	status: "open" | "filled" | "canceled";
	filledAt: number | null;
	fillPrice: number | null;
	fee: number | null;
	canceledAt: number | null;
	cancelReason: string | null;
	/** 発注した判断の理由 */
	reason: string;
	/** 対応する買い / 売りの注文 */
	pairId: string | null;
	/** 売りの約定で確定した往復の損益（手数料込み） */
	pnl: number | null;
};

export type DecisionLog = {
	time: number;
	/** 判定時の現在値（直前に確定した足の終値） */
	price: number;
	cash: number;
	position: Position;
	openOrderIds: string[];
	intents: OrderIntent[];
	nextEvalAt: number;
	note: string | null;
	state: JsonValue;
};

export type Trade = {
	buyOrderId: string;
	sellOrderId: string;
	entryTime: number;
	exitTime: number;
	quantity: number;
	/** 手数料込みの損益 */
	pnl: number;
};

export type BacktestSummary = {
	initialCash: number;
	/** 最終資金。未決済のポジションは最後の足の終値で評価する */
	finalEquity: number;
	pnl: number;
	pnlPercent: number;
	/** 同期間のガチホの損益率 */
	buyAndHoldPercent: number;
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
	/** 平均保有期間（ミリ秒）。取引が無ければ null */
	averageHoldingMs: number | null;
	/** 期間の最後に持っていた数量（satoshi） */
	openPositionQuantity: number;
};

export type BacktestResult = {
	summary: BacktestSummary;
	orders: BacktestOrder[];
	trades: Trade[];
	decisions: DecisionLog[];
	/** 期間内の戦略の粒度の足（チャートに使う） */
	candles: Candle[];
};

/** データが戦略の粒度より粗ければエラーにする（日足では分単位の戦略を検証できないため） */
export function checkDataResolution(
	dataTimeframe: Timeframe,
	strategyTimeframe: Timeframe,
): void {
	if (isCoarser(dataTimeframe, strategyTimeframe)) {
		throw new BacktestError(
			`取り込み済みのデータは${TIMEFRAME_LABELS[dataTimeframe]}までで、戦略の${TIMEFRAME_LABELS[strategyTimeframe]}より粗いため実行できない`,
		);
	}
}

/** 現金で買える最大の数量（手数料込み） */
function maxAffordable(cash: number, price: number, ratePpm: number): number {
	const cost = (q: number) =>
		notionalYen(price, q, "ceil") + feeYen(price, q, ratePpm);
	// 丸めを無視した上限から二分探索する（1 satoshi ずつ減らすと価格が安いとき終わらない）
	let lo = 0;
	let hi = Math.floor(
		(cash * SATOSHI_PER_BTC * PPM) / (price * (PPM + ratePpm)),
	);
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (cost(mid) <= cash) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

export function runBacktest<P>(config: BacktestConfig<P>): BacktestResult {
	const {
		strategy,
		params,
		candles: all,
		from,
		to,
		initialCash,
		fees,
		fillModel = defaultFillModel,
		onProgress,
		shouldAbort,
	} = config;
	const timeframe = strategy.minResolution(params);
	checkDataResolution(config.dataTimeframe, timeframe);
	const tfMs = TIMEFRAME_MS[timeframe];
	const history = Math.max(1, strategy.historyBars(params));
	const steps = config.stepCandles ?? all;
	const stepTimeframe = config.stepTimeframe ?? timeframe;
	if (isCoarser(stepTimeframe, timeframe)) {
		throw new BacktestError("判定に使う足が戦略の粒度より粗い");
	}
	const stepMs = TIMEFRAME_MS[stepTimeframe];
	const judges = strategy.requiredJudges(params);
	if (judges.length > 0 && !config.judgments) {
		throw new BacktestError(
			"AI 判定の条件があるのに、判定の材料が渡されていない",
		);
	}
	const judgeAtTime =
		judges.length > 0 && config.judgments
			? judgmentCursor(config.judgments.news, config.judgments.rule)
			: null;
	const judgmentsAt = (time: number) => {
		if (!judgeAtTime) return {};
		const v = judgeAtTime(time);
		return Object.fromEntries(
			judges.map((j) => [
				j,
				[{ judge: j, time, label: v[j as keyof typeof v] }],
			]),
		);
	};

	const startIndex = steps.findIndex((c) => c.time >= from);
	const endIndex = steps.findLastIndex((c) => c.time < to);
	if (startIndex < 0 || endIndex < startIndex) {
		throw new BacktestError("期間に足が無い");
	}
	const total = endIndex - startIndex + 1;
	// 判定時点で確定している戦略の粒度の足の数（all の先頭から）
	let completed = 0;
	// 判定時点で途中の戦略の粒度の足。細かい足から組み立てる
	let forming = null as Candle | null;

	let cash = initialCash;
	let position: Position = EMPTY_POSITION;
	let state: JsonValue = null;
	let nextEvalAt = Number.NEGATIVE_INFINITY;
	let seq = 0;
	const orders: BacktestOrder[] = [];
	const open: { order: Order; record: BacktestOrder }[] = [];
	const trades: Trade[] = [];
	const decisions: DecisionLog[] = [];
	let entry: { orderId: string; time: number; cost: number } | null = null;

	let peak = initialCash;
	let peakAt = steps[startIndex]?.time ?? from;
	let maxDd = 0;
	let ddFrom: number | null = null;
	let ddTo: number | null = null;

	const feeRate = (type: OrderType) =>
		type === "limit" ? fees.limitPpm : fees.marketPpm;

	const applyFill = (
		item: { order: Order; record: BacktestOrder },
		price: number,
		time: number,
	) => {
		const { order, record } = item;
		const fee = feeYen(price, order.quantity, feeRate(order.type));
		if (order.side === "buy") {
			const cost = notionalYen(price, order.quantity, "ceil");
			cash -= cost + fee;
			// ポジションは1つだけ持つが、買い増しが起きても平均の買値を保つ
			const qty = position.quantity + order.quantity;
			const entryPrice =
				position.entryPrice === null
					? price
					: (position.entryPrice * position.quantity + price * order.quantity) /
						qty;
			position = {
				quantity: qty,
				entryPrice,
				openedAt: position.openedAt ?? time,
			};
			entry = entry
				? { ...entry, cost: entry.cost + cost + fee }
				: { orderId: order.id, time, cost: cost + fee };
		} else {
			const proceeds = notionalYen(price, order.quantity, "floor");
			cash += proceeds - fee;
			const qty = position.quantity - order.quantity;
			position = qty > 0 ? { ...position, quantity: qty } : EMPTY_POSITION;
			if (qty === 0 && entry) {
				// 往復の損益は、売りの受け取り − 買いの支払い（どちらも手数料込み）
				const pnl = proceeds - fee - entry.cost;
				trades.push({
					buyOrderId: entry.orderId,
					sellOrderId: order.id,
					entryTime: entry.time,
					exitTime: time,
					quantity: order.quantity,
					pnl,
				});
				record.pnl = pnl;
				record.pairId = entry.orderId;
				const buyId = entry.orderId;
				const buy = orders.find((o) => o.id === buyId);
				if (buy) buy.pairId = order.id;
				entry = null;
			}
		}
		order.status = "filled";
		record.status = "filled";
		record.filledAt = time;
		record.fillPrice = price;
		record.fee = fee;
	};

	const place = (
		intent: Extract<OrderIntent, { kind: "place" }>,
		now: number,
		reason: string,
	) => {
		if (intent.type === "limit" && intent.price === undefined) {
			return "指値の価格が無いため発注しない";
		}
		if (intent.side === "buy" && intent.type === "limit") {
			const price = intent.price as number;
			const need =
				notionalYen(price, intent.quantity, "ceil") +
				feeYen(price, intent.quantity, fees.limitPpm);
			if (cash < need) {
				return `資金 ${formatYen(cash)} 円が手数料込みの注文額 ${formatYen(need)} 円に足りないため発注しない`;
			}
		}
		if (intent.side === "sell" && intent.quantity > position.quantity) {
			return `保有 ${formatBtc(position.quantity)} BTC より多くは売れないため発注しない`;
		}
		seq++;
		const order: Order = {
			id: `o${seq}`,
			side: intent.side,
			type: intent.type,
			price: intent.type === "limit" ? (intent.price as number) : null,
			quantity: intent.quantity,
			placedAt: now,
			expiresAt:
				intent.expireAfterBars === undefined
					? null
					: now + intent.expireAfterBars * tfMs,
			status: "open",
		};
		const record: BacktestOrder = {
			id: order.id,
			side: order.side,
			type: order.type,
			price: order.price,
			quantity: order.quantity,
			placedAt: now,
			status: "open",
			filledAt: null,
			fillPrice: null,
			fee: null,
			canceledAt: null,
			cancelReason: null,
			reason,
			pairId: null,
			pnl: null,
		};
		orders.push(record);
		open.push({ order, record });
		return null;
	};

	const cancel = (
		item: { order: Order; record: BacktestOrder },
		time: number,
		reason: string,
	) => {
		item.order.status = "canceled";
		item.record.status = "canceled";
		item.record.canceledAt = time;
		item.record.cancelReason = reason;
	};

	const removeClosed = () => {
		for (let k = open.length - 1; k >= 0; k--) {
			if (open[k]?.order.status !== "open") open.splice(k, 1);
		}
	};

	for (let i = startIndex; i <= endIndex; i++) {
		if (shouldAbort?.()) {
			throw new BacktestAborted("中止した");
		}
		const bar = steps[i] as Candle;
		const closeAt = bar.time + stepMs;

		// 足の中の約定
		let filled = false;
		for (const item of open) {
			const price = fillModel(item.order, bar);
			if (price !== null) {
				applyFill(item, price, bar.time);
				filled = true;
			}
		}
		removeClosed();

		// 足の終わり：期限切れの取消、判定
		for (const item of open) {
			const exp = item.order.expiresAt;
			if (exp !== null && closeAt >= exp) {
				const bars = Math.round((exp - item.order.placedAt) / tfMs);
				cancel(
					item,
					closeAt,
					`指値 ${formatYen(item.order.price ?? 0)} が ${bars} 本のあいだ約定しなかったため取消`,
				);
			}
		}
		removeClosed();

		const barStart = candleStart(bar.time, timeframe);
		const prev = forming;
		forming =
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

		if (filled || closeAt >= nextEvalAt) {
			while (
				completed < all.length &&
				(all[completed] as Candle).time < barStart
			) {
				completed++;
			}
			// 確定した足に、途中の足（今の足）を足して渡す。細かい足で進めていなければ今の足そのもの
			const window = [
				...all.slice(Math.max(0, completed - (history - 1)), completed),
				forming,
			];
			const openOrders = open.map((x) => ({ ...x.order }));

			const out: StrategyOutput = strategy.evaluate({
				now: closeAt,
				candles: window,
				judgments: judgmentsAt(closeAt),
				position,
				cash,
				openOrders,
				params,
				state,
			});
			const notes: string[] = out.note ? [out.note] : [];
			for (const intent of out.intents) {
				if (intent.kind === "place") {
					const rejected = place(intent, closeAt, out.note ?? "");
					if (rejected) notes.push(rejected);
				} else {
					const item = open.find((x) => x.order.id === intent.orderId);
					if (item) cancel(item, closeAt, intent.reason ?? "戦略が取消");
				}
			}
			removeClosed();
			decisions.push({
				time: closeAt,
				price: bar.close,
				cash,
				position,
				openOrderIds: openOrders.map((o) => o.id),
				intents: out.intents,
				nextEvalAt: out.nextEvalAt,
				note: notes.length ? notes.join("。") : null,
				state: out.state,
			});
			state = out.state;
			nextEvalAt = out.nextEvalAt;
		}

		// 足ごとの時価評価でドローダウンを測る
		const equity = cash + notionalYen(bar.close, position.quantity, "floor");
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

		const done = i - startIndex + 1;
		if (onProgress && (done % 1000 === 0 || done === total)) {
			onProgress(done, total);
		}
	}

	const first = steps[startIndex] as Candle;
	const last = steps[endIndex] as Candle;
	for (const item of open) {
		cancel(item, last.time + stepMs, "期間の終わりまで約定しなかった");
	}

	const finalEquity =
		cash + notionalYen(last.close, position.quantity, "floor");
	const hodlQty = maxAffordable(initialCash, first.open, fees.marketPpm);
	const hodlFinal =
		initialCash -
		notionalYen(first.open, hodlQty, "ceil") -
		feeYen(first.open, hodlQty, fees.marketPpm) +
		notionalYen(last.close, hodlQty, "floor");
	const wins = trades.filter((t) => t.pnl > 0);
	const losses = trades.filter((t) => t.pnl <= 0);
	const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
	const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);

	return {
		summary: {
			initialCash,
			finalEquity,
			pnl: finalEquity - initialCash,
			pnlPercent: ((finalEquity - initialCash) / initialCash) * 100,
			buyAndHoldPercent: ((hodlFinal - initialCash) / initialCash) * 100,
			trades: trades.length,
			wins: wins.length,
			losses: losses.length,
			winRate: trades.length ? (wins.length / trades.length) * 100 : null,
			profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
			maxDrawdownPercent: maxDd * 100,
			maxDrawdownFrom: ddFrom,
			maxDrawdownTo: ddTo,
			averageHoldingMs: trades.length
				? trades.reduce((a, t) => a + (t.exitTime - t.entryTime), 0) /
					trades.length
				: null,
			openPositionQuantity: position.quantity,
		},
		orders,
		trades,
		decisions,
		candles: all.filter((c) => c.time >= from && c.time < to),
	};
}
