// テストと E2E で使う、取引所の代わりに約定を流す偽物

import type { MarketTrade } from "@trading-studio/core";
import type { FeedHandlers, TradeFeed } from "./types";

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
export function demoFeed(now: () => number = Date.now): TradeFeed {
	let id = 0;
	const trade = (time: number): MarketTrade => {
		id++;
		return {
			id,
			time,
			price: 13_000_000 + Math.round(Math.sin(id / 30) * 50_000),
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
