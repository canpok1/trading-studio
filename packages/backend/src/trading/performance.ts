// 自動取引の成績。口座をリセットした時点以降の約定から、バックテスト結果と同じ指標を出す

import type { Position, TradeOrder } from "@trading-studio/core";
import { notionalYen } from "@trading-studio/core";
import type { TradingPerformance } from "./types";

/** 評価に使う価格。足の終値なら足の終わりの時刻 */
export type PricePoint = { time: number; price: number };

/** 現金と保有を今の価格で評価した資産。保有があって価格が分からなければ null */
export function equityOf(
	cash: number,
	position: Position,
	price: number | null,
): number | null {
	if (position.quantity === 0) return cash;
	return price === null
		? null
		: cash + notionalYen(price, position.quantity, "floor");
}

/**
 * fills はリセット以降に約定した注文（約定の古い順）。prices は評価する時点の価格（古い順）。
 * 最大ドローダウンは、約定の直後（約定価格）と prices の各時点、今の時点で資産を評価して測る
 */
export function tradingPerformance({
	initialCash,
	resetAt,
	now,
	cash,
	position,
	price,
	fills,
	prices,
}: {
	initialCash: number;
	resetAt: number;
	now: number;
	cash: number;
	position: Position;
	price: number | null;
	fills: readonly TradeOrder[];
	prices: readonly PricePoint[];
}): TradingPerformance {
	// 約定をたどって、各時点の現金と数量を出す（core の約定と同じ丸め）
	let c = initialCash;
	let qty = 0;
	let peak = initialCash;
	let peakAt = resetAt;
	let maxDd = 0;
	let ddFrom: number | null = null;
	let ddTo: number | null = null;
	const mark = (time: number, p: number) => {
		const equity = c + notionalYen(p, qty, "floor");
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
			const p = f.fillPrice ?? 0;
			const fee = f.fee ?? 0;
			if (f.side === "buy") {
				c -= notionalYen(p, f.quantity, "ceil") + fee;
				qty += f.quantity;
			} else {
				c += notionalYen(p, f.quantity, "floor") - fee;
				qty -= f.quantity;
			}
			mark(f.filledAt ?? 0, p);
		}
	};
	for (const pt of prices) {
		if (pt.time <= resetAt || pt.time > now) continue;
		applyUntil(pt.time);
		mark(pt.time, pt.price);
	}
	applyUntil(now);
	const equity = equityOf(cash, position, price);
	if (equity !== null && price !== null) mark(now, price);

	// 往復は売りの約定（損益つき）と、対応づけた買いの約定時刻から作る
	const buyTime = new Map(
		fills.filter((f) => f.side === "buy").map((f) => [f.id, f.filledAt ?? 0]),
	);
	const trades = fills.flatMap((f) =>
		f.side === "sell" && f.pnl !== null
			? [
					{
						pnl: f.pnl,
						holdingMs:
							(f.filledAt ?? 0) -
							(buyTime.get(f.pairId ?? "") ?? f.filledAt ?? 0),
					},
				]
			: [],
	);
	const wins = trades.filter((t) => t.pnl > 0);
	const losses = trades.filter((t) => t.pnl <= 0);
	const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
	const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
	const realizedPnl = trades.reduce((a, t) => a + t.pnl, 0);
	const pnl = equity === null ? null : equity - initialCash;

	return {
		resetAt,
		initialCash,
		cash,
		position,
		price,
		equity,
		pnl,
		pnlPercent: pnl === null ? null : (pnl / initialCash) * 100,
		realizedPnl,
		trades: trades.length,
		wins: wins.length,
		losses: losses.length,
		winRate: trades.length ? (wins.length / trades.length) * 100 : null,
		profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
		maxDrawdownPercent: maxDd * 100,
		maxDrawdownFrom: ddFrom,
		maxDrawdownTo: ddTo,
		averageHoldingMs: trades.length
			? trades.reduce((a, t) => a + t.holdingMs, 0) / trades.length
			: null,
	};
}
