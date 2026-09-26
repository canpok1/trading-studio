// 約定の列から1分足を組み立てる（価格収集で使う）

import { candleStart, TIMEFRAME_MS } from "./timeframe";
import type { Candle } from "./types";

const MINUTE = TIMEFRAME_MS["1m"];

/** 取引所の約定。価格は円、数量は satoshi、時刻は UTC のエポックミリ秒 */
export type MarketTrade = {
	/** 取引所の約定 ID。重複の判定と、同じ時刻の約定の並び順に使う */
	id: number;
	time: number;
	price: number;
	quantity: number;
};

/**
 * 1分足の組み立ての途中の状態。1つの接続（途切れずに約定を受けられている間）に1つ使う。
 * 切断したら捨てて、つなぎ直した後に作り直す（途切れた間の分を作らず、欠損として残すため）
 */
export type MinuteCandleState = {
	/** 最初に作る足の開始時刻 */
	firstMinute: number;
	/** 次に確定する分の開始時刻 */
	nextMinute: number;
	/** 確定前の約定 */
	pending: readonly MarketTrade[];
	/** 直前の価格。約定の無い分の横ばいの足に使う */
	lastClose: number | null;
	/** 最初の足より前で最も新しい約定。最初の足の直前の価格を知るためだけに持つ */
	beforeStart: MarketTrade | null;
	/** 受けた中で最も新しい約定 */
	latest: MarketTrade | null;
};

/** 約定の前後。時刻が同じなら ID の小さい方が先（取引所の時刻は秒単位のため） */
export function compareMarketTrades(a: MarketTrade, b: MarketTrade): number {
	return a.time - b.time || a.id - b.id;
}

function newer(a: MarketTrade | null, b: MarketTrade): MarketTrade {
	return a === null || compareMarketTrades(b, a) > 0 ? b : a;
}

/**
 * 約定を漏れなく受け始めた時刻から状態を作る。足はその時刻を含む分の次の分から作る
 * （ちょうど分の始まりならその分から）。途中から受けた分は約定が欠けている恐れがあるため
 */
export function startMinuteCandles(coveredFrom: number): MinuteCandleState {
	const start = candleStart(coveredFrom, "1m");
	const firstMinute = start === coveredFrom ? start : start + MINUTE;
	return {
		firstMinute,
		nextMinute: firstMinute,
		pending: [],
		lastClose: null,
		beforeStart: null,
		latest: null,
	};
}

/**
 * 約定を加える。確定前の分なら時刻の前後は問わない。
 * 同じ ID の約定と、確定済みの分に遅れて届いた約定は捨てる（同じ状態を返す）
 */
export function addTrade(
	state: MinuteCandleState,
	trade: MarketTrade,
): MinuteCandleState {
	for (const key of ["id", "time", "price", "quantity"] as const) {
		if (!Number.isSafeInteger(trade[key])) {
			throw new RangeError(`約定の ${key} は整数で渡す: ${trade[key]}`);
		}
	}
	if (trade.time < state.nextMinute) {
		const usableBeforeStart =
			state.nextMinute === state.firstMinute &&
			(state.beforeStart === null ||
				compareMarketTrades(trade, state.beforeStart) > 0);
		if (!usableBeforeStart) {
			return state;
		}
		return {
			...state,
			beforeStart: trade,
			lastClose: trade.price,
			latest: newer(state.latest, trade),
		};
	}
	if (state.pending.some((t) => t.id === trade.id)) {
		return state;
	}
	return {
		...state,
		pending: [...state.pending, trade],
		latest: newer(state.latest, trade),
	};
}

/** 1分の約定（時刻順）から足を作る */
function candleOf(minute: number, trades: readonly MarketTrade[]): Candle {
	const first = trades[0] as MarketTrade;
	const last = trades[trades.length - 1] as MarketTrade;
	let high = first.price;
	let low = first.price;
	let volume = 0;
	for (const t of trades) {
		high = Math.max(high, t.price);
		low = Math.min(low, t.price);
		volume += t.quantity;
	}
	return {
		time: minute,
		open: first.price,
		high,
		low,
		close: last.price,
		volume,
	};
}

function flatCandle(minute: number, price: number): Candle {
	return {
		time: minute,
		open: price,
		high: price,
		low: price,
		close: price,
		volume: 0,
	};
}

/**
 * 時刻 now までに終わった分の足を確定して古い順に返す。
 * 分が終わってから graceMs 待つ（遅れて届く約定を待つため）。
 * 約定の無い分は直前の価格で横ばいの足（出来高 0）にする。直前の価格が分からなければ作らない
 */
export function closeMinutes(
	state: MinuteCandleState,
	now: number,
	graceMs = 2_000,
): { state: MinuteCandleState; candles: Candle[] } {
	const candles: Candle[] = [];
	let { nextMinute, pending, lastClose } = state;
	while (nextMinute + MINUTE + graceMs <= now) {
		const end = nextMinute + MINUTE;
		const inMinute = pending
			.filter((t) => t.time < end)
			.sort(compareMarketTrades);
		if (inMinute.length > 0) {
			const candle = candleOf(nextMinute, inMinute);
			candles.push(candle);
			lastClose = candle.close;
			pending = pending.filter((t) => t.time >= end);
		} else if (lastClose !== null) {
			candles.push(flatCandle(nextMinute, lastClose));
		}
		nextMinute = end;
	}
	if (nextMinute === state.nextMinute) {
		return { state, candles };
	}
	return {
		state: { ...state, nextMinute, pending, lastClose, beforeStart: null },
		candles,
	};
}

/**
 * 時刻 now を含む分の、形成中の足。その分の約定だけで作り、約定が無ければ直前の価格で横ばいにする。
 * その分が確定済みか、価格が分からなければ null
 */
export function formingCandle(
	state: MinuteCandleState,
	now: number,
): Candle | null {
	const minute = candleStart(now, "1m");
	if (minute < state.nextMinute) {
		return null;
	}
	const inMinute = state.pending
		.filter((t) => t.time >= minute && t.time < minute + MINUTE)
		.sort(compareMarketTrades);
	if (inMinute.length > 0) {
		return candleOf(minute, inMinute);
	}
	const before = state.pending
		.filter((t) => t.time < minute)
		.sort(compareMarketTrades)
		.at(-1);
	const price = before?.price ?? state.lastClose;
	return price === null ? null : flatCandle(minute, price);
}
