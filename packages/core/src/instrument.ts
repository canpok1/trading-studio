// 通貨・市場・銘柄（ADR 0036）。金額は通貨の、価格・数量は銘柄の最小単位の整数で持つ

export type Currency = {
	code: string;
	/** 画面で値の後ろに付ける単位 */
	unit: string;
	/** 最小単位の桁。円は 0、ドルは 2（セント） */
	decimals: number;
};

/** 市場。1つの戦略は1つの市場だけを扱う */
export type Market = {
	/** 保存するデータで市場を指す */
	id: string;
	name: string;
	currency: Currency;
	/** IANA のタイムゾーン */
	timeZone: string;
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
};

export const JPY: Currency = { code: "JPY", unit: "円", decimals: 0 };

export const COINCHECK: Market = {
	id: "coincheck",
	name: "Coincheck",
	currency: JPY,
	timeZone: "Asia/Tokyo",
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
};

export const MARKETS: readonly Market[] = [COINCHECK];
export const INSTRUMENTS: readonly Instrument[] = [BTC_JPY];

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

/** 数量 1（BTC なら 1 BTC）を最小単位で表した値 */
export function quantityScale(instrument: Instrument): number {
	return 10 ** instrument.quantityDecimals;
}

/** 通貨での値（小数）を価格の最小単位の整数へ（四捨五入） */
export function toPriceUnits(instrument: Instrument, value: number): number {
	return Math.round(value * 10 ** instrument.priceDecimals);
}
