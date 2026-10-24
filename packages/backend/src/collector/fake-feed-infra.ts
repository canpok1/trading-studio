// テストと E2E で使う、取引所の代わりに約定を流す偽物

import type { Instrument, MarketTrade } from "@trading-studio/core";
import { toPriceUnits } from "@trading-studio/core";
import type { FeedHandlers, TradeFeed } from "./collector-domain";

/** テストから接続・約定・切断を操作する */
export function manualFeed() {
	let handlers: FeedHandlers | null = null;
	let recent: MarketTrade[] = [];
	let connects = 0;
	const feed: TradeFeed = {
		connect(h) {
			handlers = h;
			connects++;
			return {
				close() {
					if (handlers === h) handlers = null;
				},
			};
		},
		async recentTrades() {
			return recent;
		},
	};
	const current = () => {
		if (!handlers) throw new Error("接続していない");
		return handlers;
	};
	return {
		feed,
		connects: () => connects,
		connected: () => handlers !== null,
		setRecent(trades: MarketTrade[]) {
			recent = trades;
		},
		ready() {
			current().onMessage();
			current().onReady();
		},
		trades(trades: MarketTrade[]) {
			current().onMessage();
			current().onTrades(trades);
		},
		heartbeat() {
			current().onMessage();
		},
		close(reason = "切断") {
			const h = current();
			handlers = null;
			h.onClose(reason);
		},
	};
}

/**
 * E2E 用。接続するとすぐ購読が始まり、1秒ごとに約定を1件流す。価格は決まった形で上下する
 * （E2E で Coincheck へつながないため）
 */
export function demoFeed({
	now = Date.now,
	basePrice = 13_000_000,
	swing = 50_000,
}: {
	now?: () => number;
	/** 価格の中心と振れ幅（価格の最小単位） */
	basePrice?: number;
	swing?: number;
} = {}): TradeFeed {
	let id = 0;
	const trade = (time: number): MarketTrade => {
		id++;
		return {
			id,
			time,
			price: basePrice + Math.round(Math.sin(id / 30) * swing),
			quantity: 1_000_000,
		};
	};
	return {
		connect(handlers) {
			const timer = setInterval(() => {
				handlers.onMessage();
				handlers.onTrades([trade(Math.floor(now() / 1000) * 1000)]);
			}, 1_000);
			queueMicrotask(() => {
				handlers.onMessage();
				handlers.onReady();
			});
			return { close: () => clearInterval(timer) };
		},
		async recentTrades() {
			return [];
		},
	};
}

/** E2E 用。銘柄ごとにそれらしい価格で流す */
export function demoFeedOf(instrument: Instrument): TradeFeed {
	const yen: Record<string, number> = {
		"coincheck:btc_jpy": 13_000_000,
		"coincheck:eth_jpy": 370_000,
		"coincheck:xrp_jpy": 200,
	};
	const basePrice = toPriceUnits(instrument, yen[instrument.id] ?? 100);
	return demoFeed({
		basePrice,
		swing: Math.round(basePrice / 260),
	});
}
