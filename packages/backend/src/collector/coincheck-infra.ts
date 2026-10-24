// Coincheck の公開 WebSocket と公開 API から1銘柄の約定を受ける（docs/adr/0007）

import type { Instrument, MarketTrade } from "@trading-studio/core";
import { parseQuantity, toPriceUnits } from "@trading-studio/core";
import type { TradeFeed } from "./collector-domain";

const WS_URL = "wss://ws-api.coincheck.com/";

/** 取引所の通貨ペアの名前。"BTC/JPY" → "btc_jpy" */
export function coincheckPair(instrument: Instrument): string {
	return instrument.symbol.replace("/", "_").toLowerCase();
}

/** 取引所の数量の文字列（"0.5" や "7.0e-08"）を数量の最小単位へ */
function toQuantityUnits(instrument: Instrument, amount: string): number {
	return parseQuantity(
		instrument,
		/e/i.test(amount)
			? Number(amount).toFixed(instrument.quantityDecimals)
			: amount,
	);
}

/**
 * WebSocket の取引履歴チャンネルの1件。
 * [約定時刻(秒), 約定ID, 取引ペア, レート, 量, 注文方法, TakerID, MakerID, 板寄せID]
 */
export function parseWsTrade(
	instrument: Instrument,
	row: unknown,
): MarketTrade | null {
	if (!Array.isArray(row) || row[2] !== coincheckPair(instrument)) return null;
	const [time, id, , rate, amount] = row as string[];
	const trade = {
		id: Number(id),
		time: Number(time) * 1000,
		price: toPriceUnits(instrument, Number(rate)),
		quantity: toQuantityUnits(instrument, String(amount)),
	};
	return Object.values(trade).every(Number.isSafeInteger) ? trade : null;
}

/** 公開 API の全取引履歴の1件 */
export function parseRestTrade(
	instrument: Instrument,
	row: {
		id: number;
		amount: string;
		rate: string;
		pair: string;
		created_at: string;
	},
): MarketTrade | null {
	if (row.pair !== coincheckPair(instrument)) return null;
	const trade = {
		id: row.id,
		time: Date.parse(row.created_at),
		price: toPriceUnits(instrument, Number(row.rate)),
		quantity: toQuantityUnits(instrument, row.amount),
	};
	return Object.values(trade).every(Number.isSafeInteger) ? trade : null;
}

export function coincheckFeed(instrument: Instrument): TradeFeed {
	const pair = coincheckPair(instrument);
	const tradesUrl = `https://coincheck.com/api/trades?pair=${pair}&limit=100`;
	return {
		connect(handlers) {
			const ws = new WebSocket(WS_URL);
			let ready = false;
			ws.onopen = () => {
				ws.send(
					JSON.stringify({ type: "subscribe", channel: `${pair}-trades` }),
				);
				// 板情報は頻繁に届くので、接続が生きている印と購読が始まった合図に使う
				ws.send(
					JSON.stringify({ type: "subscribe", channel: `${pair}-orderbook` }),
				);
			};
			ws.onmessage = (e) => {
				handlers.onMessage();
				let msg: unknown;
				try {
					msg = JSON.parse(String(e.data));
				} catch {
					return;
				}
				if (!Array.isArray(msg)) return;
				if (Array.isArray(msg[0])) {
					const trades = msg
						.map((row) => parseWsTrade(instrument, row))
						.filter((t): t is MarketTrade => t !== null);
					if (trades.length > 0) handlers.onTrades(trades);
				}
				// 約定チャンネルを先に購読しているので、何かが届いた時点で約定も届く状態になっている
				if (!ready) {
					ready = true;
					handlers.onReady();
				}
			};
			ws.onclose = (e) => {
				handlers.onClose(
					`取引所との接続が切れた（コード ${e.code}${e.reason ? `: ${e.reason}` : ""}）`,
				);
			};
			ws.onerror = () => {
				// onclose が続けて呼ばれるので、そちらで扱う
			};
			return { close: () => ws.close() };
		},

		async recentTrades() {
			const res = await fetch(tradesUrl, {
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as {
				success: boolean;
				data: Parameters<typeof parseRestTrade>[1][];
			};
			if (!body.success) throw new Error("success=false");
			return body.data
				.map((row) => parseRestTrade(instrument, row))
				.filter((t): t is MarketTrade => t !== null);
		},
	};
}
