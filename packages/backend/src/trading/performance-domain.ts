// 自動取引の成績。口座をリセットした時点以降の約定から、バックテスト結果と同じ指標を出す

import type { Instrument, Position, TradeOrder } from "@trading-studio/core";
import { findInstrument, notional } from "@trading-studio/core";
import type { RoundTripStats, TradingPerformance } from "./types-domain";

/** 評価に使う価格。足の終値なら足の終わりの時刻 */
export type PricePoint = { time: number; price: number };

/** 1銘柄の保有と、今の価格 */
export type Holding = {
	instrument: Instrument;
	quantity: number;
	price: number | null;
};

/** 現金と保有を今の価格で評価した資産。保有があって価格が分からない銘柄があれば null */
export function equityOf(
	cash: number,
	holdings: readonly Holding[],
): number | null {
	let equity = cash;
	for (const h of holdings) {
		if (h.quantity === 0) continue;
		if (h.price === null) return null;
		equity += notional(h.instrument, h.price, h.quantity, "floor");
	}
	return equity;
}

/** 成績を出す1銘柄の材料 */
export type PerformanceMarket = {
	instrument: Instrument;
	position: Position;
	/** 今の価格。分からなければ null */
	price: number | null;
	/** 評価する時点の価格（古い順） */
	prices: readonly PricePoint[];
	/** リセットした時点の価格。分からなければ null */
	basePrice: number | null;
};

/**
 * fills はリセット以降に約定した注文（約定の古い順）。銘柄を持たない約定は markets の先頭の銘柄として読む。
 * 最大ドローダウンは、約定の直後（約定価格）と各銘柄の prices の各時点、今の時点で資産を評価して測る（評価しない銘柄は最後に分かった価格で評価する）。
 * position・price・buyHoldPercent 以外は全銘柄の合計。銘柄が2つ以上なら銘柄ごとの往復の成績も出す（ADR 0037）
 */
export function tradingPerformance({
	initialCash,
	resetAt,
	now,
	cash,
	markets,
	fills,
}: {
	initialCash: number;
	resetAt: number;
	now: number;
	cash: number;
	markets: readonly [PerformanceMarket, ...PerformanceMarket[]];
	fills: readonly (TradeOrder & { instrument?: string })[];
}): TradingPerformance {
	const [head] = markets;
	const idOf = (f: { instrument?: string }) =>
		f.instrument ?? head.instrument.id;
	// 候補を変えた後は、リセット以降の約定に今の候補に無い銘柄が残りうる
	const instrumentOf = (id: string) =>
		markets.find((m) => m.instrument.id === id)?.instrument ??
		findInstrument(id) ??
		head.instrument;
	// 約定をたどって、各時点の現金と銘柄ごとの数量・最後の価格を出す（core の約定と同じ丸め）
	let c = initialCash;
	const qty = new Map<string, number>();
	const last = new Map<string, number>();
	let peak = initialCash;
	let peakAt = resetAt;
	let maxDd = 0;
	let ddFrom: number | null = null;
	let ddTo: number | null = null;
	const mark = (time: number) => {
		let equity = c;
		for (const [id, q] of qty) {
			equity += notional(instrumentOf(id), last.get(id) ?? 0, q, "floor");
		}
		if (equity > peak) {
			peak = equity;
			peakAt = time;
		}
		const dd = peak > 0 ? (peak - equity) / peak : 0;
		if (dd > maxDd) {
			maxDd = dd;
			ddFrom = peakAt;
			ddTo = time;
		}
	};
	let i = 0;
	const applyUntil = (time: number) => {
		for (; i < fills.length; i++) {
			const f = fills[i] as TradeOrder;
			if ((f.filledAt ?? 0) > time) break;
			const id = idOf(f);
			const instrument = instrumentOf(id);
			const p = f.fillPrice ?? 0;
			const fee = f.fee ?? 0;
			if (f.side === "buy") {
				c -= notional(instrument, p, f.quantity, "ceil") + fee;
				qty.set(id, (qty.get(id) ?? 0) + f.quantity);
			} else {
				c += notional(instrument, p, f.quantity, "floor") - fee;
				qty.set(id, (qty.get(id) ?? 0) - f.quantity);
			}
			last.set(id, p);
			mark(f.filledAt ?? 0);
		}
	};
	// 同じ時刻の価格は、全銘柄に当ててから1回だけ評価する（銘柄ごとに評価すると、新旧の価格が混ざった資産を測る）
	const points = markets
		.flatMap((m) => m.prices.map((pt) => ({ id: m.instrument.id, ...pt })))
		.filter((pt) => pt.time > resetAt && pt.time <= now)
		.sort((a, b) => a.time - b.time);
	for (let k = 0; k < points.length; ) {
		const time = (points[k] as (typeof points)[number]).time;
		applyUntil(time);
		for (; k < points.length && points[k]?.time === time; k++) {
			const pt = points[k] as (typeof points)[number];
			last.set(pt.id, pt.price);
		}
		mark(time);
	}
	applyUntil(now);
	const holdings = markets.map((m) => ({
		instrument: m.instrument,
		quantity: m.position.quantity,
		price: m.price,
	}));
	const equity = equityOf(cash, holdings);
	if (equity !== null && markets.some((m) => m.price !== null)) {
		for (const m of markets)
			if (m.price !== null) last.set(m.instrument.id, m.price);
		mark(now);
	}

	const buyHoldOf = (m: PerformanceMarket) =>
		m.basePrice !== null && m.basePrice > 0 && m.price !== null
			? (m.price / m.basePrice - 1) * 100
			: null;
	// ただ持っていた場合は、価格の分かる銘柄に等分したものとする（バックテストと同じ）
	const holds = markets.map(buyHoldOf).filter((x) => x !== null);

	const all = roundTrips(fills);
	const pnl = equity === null ? null : equity - initialCash;

	return {
		resetAt,
		initialCash,
		cash,
		position: head.position,
		price: head.price,
		equity,
		pnl,
		pnlPercent: pnl === null ? null : (pnl / initialCash) * 100,
		buyHoldPercent: holds.length
			? holds.reduce((a, x) => a + x, 0) / holds.length
			: null,
		...all,
		maxDrawdownPercent: maxDd * 100,
		maxDrawdownFrom: ddFrom,
		maxDrawdownTo: ddTo,
		...(markets.length > 1
			? {
					byInstrument: Object.fromEntries(
						markets.map((m) => [
							m.instrument.id,
							roundTrips(fills.filter((f) => idOf(f) === m.instrument.id)),
						]),
					),
				}
			: {}),
	};
}

/** 約定から往復の成績を出す */
function roundTrips(fills: readonly TradeOrder[]): RoundTripStats {
	// 往復は売りの約定（損益つき）と、対応づけた買いの約定時刻から作る。
	// 一部利確の売りは、同じロットを閉じた売りの往復にまとめる（ロットが残っている間は往復に数えない）
	const buyTime = new Map(
		fills.filter((f) => f.side === "buy").map((f) => [f.id, f.filledAt ?? 0]),
	);
	const sells = fills.filter((f) => f.side === "sell" && f.pnl !== null);
	const partialPnl = new Map<string, number>();
	for (const f of sells) {
		if (f.exitKind === "partialTakeProfit" && f.pairId) {
			partialPnl.set(f.pairId, (partialPnl.get(f.pairId) ?? 0) + (f.pnl ?? 0));
		}
	}
	const trades = sells
		.filter((f) => f.exitKind !== "partialTakeProfit")
		.map((f) => ({
			pnl: (f.pnl ?? 0) + (partialPnl.get(f.pairId ?? "") ?? 0),
			holdingMs:
				(f.filledAt ?? 0) - (buyTime.get(f.pairId ?? "") ?? f.filledAt ?? 0),
		}));
	const wins = trades.filter((t) => t.pnl > 0);
	const losses = trades.filter((t) => t.pnl <= 0);
	const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
	const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
	return {
		// 確定損益は、ロットが残っている一部利確の売りも含めた売りの損益の合計
		realizedPnl: sells.reduce((a, f) => a + (f.pnl ?? 0), 0),
		trades: trades.length,
		wins: wins.length,
		losses: losses.length,
		winRate: trades.length ? (wins.length / trades.length) * 100 : null,
		profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
		averageHoldingMs: trades.length
			? trades.reduce((a, t) => a + t.holdingMs, 0) / trades.length
			: null,
	};
}
