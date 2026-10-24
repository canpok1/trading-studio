// 通貨・市場・銘柄（ADR 0036）。金額は通貨の、価格・数量は銘柄の最小単位の整数で持つ

import type { TradingCalendar } from "./trading-calendar";
import { alwaysOpenCalendar } from "./trading-calendar";

export type Currency = {
	code: string;
	/** 画面で値の後ろに付ける単位 */
	unit: string;
	/** 最小単位の桁。円は 0、ドルは 2（セント） */
	decimals: number;
};

/** 市場に紐づく判断の材料。ニュースの市場評価・DVOL・予定イベント */
export type MarketSignal = "judgment" | "dvol" | "events";

/** 市場。1つの戦略は1つの市場だけを扱う */
export type Market = {
	/** 保存するデータで市場を指す */
	id: string;
	name: string;
	currency: Currency;
	/** IANA のタイムゾーン */
	timeZone: string;
	calendar: TradingCalendar;
	/** 値幅制限。基準の価格（前日の終値）から上下に動ける幅。制限が無ければ null */
	priceLimit: ((basePrice: number) => number) | null;
	/** この市場の戦略が条件に使える材料 */
	signals: readonly MarketSignal[];
};

export type Instrument = {
	/** 保存するデータで銘柄を指す */
	id: string;
	marketId: string;
	/** 市場の中で銘柄を指す */
	symbol: string;
	/** 価格と金額の通貨 */
	currency: Currency;
	/** 価格の最小単位の桁。価格の整数 × 10^-priceDecimals が通貨での値 */
	priceDecimals: number;
	/** 数量の最小単位の桁。数量の整数 × 10^-quantityDecimals が数量 */
	quantityDecimals: number;
	/** 画面で数量の後ろに付ける単位 */
	quantityUnit: string;
	/** 画面で数量を小数何桁まで 0 で埋めるか */
	quantityMinDigits: number;
	/** 売買単位（数量の最小単位）。注文の数量はこの倍数にする */
	tradingUnit: number;
	/** 1回の注文の最小の数量（数量の最小単位） */
	minOrderQuantity: number;
	/** 買値と売値の差の率（百万分率）。固定値で持つ（ADR 0037） */
	spreadPpm: number;
};

export const JPY: Currency = { code: "JPY", unit: "円", decimals: 0 };

export const COINCHECK: Market = {
	id: "coincheck",
	name: "Coincheck",
	currency: JPY,
	timeZone: "Asia/Tokyo",
	calendar: alwaysOpenCalendar(9 * 3_600_000),
	priceLimit: null,
	// 中身は BTC 専用（ADR 0036）
	signals: ["judgment", "dvol", "events"],
};

export const BTC_JPY: Instrument = {
	id: "coincheck:btc_jpy",
	marketId: COINCHECK.id,
	symbol: "BTC/JPY",
	currency: JPY,
	priceDecimals: 0,
	quantityDecimals: 8,
	quantityUnit: "BTC",
	quantityMinDigits: 3,
	tradingUnit: 1,
	minOrderQuantity: 100_000,
	// 2026-10-24 の実測 0.02%
	spreadPpm: 200,
};

// 数量の最小単位は注文の刻み（小数5桁）。最小 0.01 ETH（Coincheck の取引注文ルール）
export const ETH_JPY: Instrument = {
	id: "coincheck:eth_jpy",
	marketId: COINCHECK.id,
	symbol: "ETH/JPY",
	currency: JPY,
	priceDecimals: 0,
	quantityDecimals: 5,
	quantityUnit: "ETH",
	quantityMinDigits: 2,
	tradingUnit: 1,
	minOrderQuantity: 1_000,
	// 2026-10-24 の実測 0.09%
	spreadPpm: 900,
};

// 価格は 0.001 円刻み。数量の最小単位は注文の刻み（小数2桁）。最小 1 XRP（Coincheck の取引注文ルール）
export const XRP_JPY: Instrument = {
	id: "coincheck:xrp_jpy",
	marketId: COINCHECK.id,
	symbol: "XRP/JPY",
	currency: JPY,
	priceDecimals: 3,
	quantityDecimals: 2,
	quantityUnit: "XRP",
	quantityMinDigits: 0,
	tradingUnit: 1,
	minOrderQuantity: 100,
	// 2026-10-24 の実測 0.12%
	spreadPpm: 1_200,
};

export const MARKETS: readonly Market[] = [COINCHECK];
export const INSTRUMENTS: readonly Instrument[] = [BTC_JPY, ETH_JPY, XRP_JPY];
/** 価格を収集する銘柄（ADR 0037） */
export const COLLECTED_INSTRUMENTS: readonly Instrument[] = INSTRUMENTS;

export function findMarket(id: string): Market | null {
	return MARKETS.find((m) => m.id === id) ?? null;
}

export function findInstrument(id: string): Instrument | null {
	return INSTRUMENTS.find((i) => i.id === id) ?? null;
}

/** 保存したデータの銘柄を引く。定義から消した銘柄は読めないので例外にする */
export function instrumentOf(id: string): Instrument {
	const i = findInstrument(id);
	if (!i) throw new RangeError(`未定義の銘柄: ${id}`);
	return i;
}

/** 銘柄の市場。銘柄の定義は必ず定義済みの市場を指す */
export function marketOf(instrument: Instrument): Market {
	const m = findMarket(instrument.marketId);
	if (!m) throw new RangeError(`未定義の市場: ${instrument.marketId}`);
	return m;
}

/** 数量 1（BTC なら 1 BTC）を最小単位で表した値 */
export function quantityScale(instrument: Instrument): number {
	return 10 ** instrument.quantityDecimals;
}

/** 通貨での値（小数）を価格の最小単位の整数へ（四捨五入） */
export function toPriceUnits(instrument: Instrument, value: number): number {
	return Math.round(value * 10 ** instrument.priceDecimals);
}
