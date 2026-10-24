// 判断理由などの文言に使う数値の書式

import type { Currency, Instrument } from "./instrument";
import { quantityToString } from "./money";

/** 最小単位の整数を3桁区切りの小数へ（最小単位未満は四捨五入）。小数は decimals 桁まで出す */
function grouped(value: number, decimals: number): string {
	const sign = value < 0 ? "-" : "";
	const digits = String(Math.abs(Math.round(value))).padStart(
		decimals + 1,
		"0",
	);
	const int = digits.slice(0, digits.length - decimals);
	const frac = digits.slice(digits.length - decimals);
	return (
		sign +
		int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
		(decimals > 0 ? `.${frac}` : "")
	);
}

/** 価格の表示（単位なし）。例: BTC/JPY の 13488215 → "13,488,215" */
export function formatPrice(instrument: Instrument, price: number): string {
	return grouped(price, instrument.priceDecimals);
}

/** 金額の表示（単位なし）。例: 円の 13488215 → "13,488,215" */
export function formatAmount(currency: Currency, amount: number): string {
	return grouped(amount, currency.decimals);
}

/** 単位付きの金額。例: 円の 13488215 → "13,488,215 円" */
export function formatMoney(currency: Currency, amount: number): string {
	return `${formatAmount(currency, amount)} ${currency.unit}`;
}

/** 単位付きの価格。例: BTC/JPY の 13488215 → "13,488,215 円" */
export function formatPriceWithUnit(
	instrument: Instrument,
	price: number,
): string {
	return `${formatPrice(instrument, price)} ${instrument.currency.unit}`;
}

/** 数量の表示（単位なし）。BTC は小数3桁までは0で埋める。例: 2000000 → "0.020" */
export function formatQuantity(
	instrument: Instrument,
	quantity: number,
): string {
	return quantityToString(instrument, quantity, instrument.quantityMinDigits);
}

/** 時間の長さ。日・時間・分のうち 0 でないものを並べる。1分未満は秒。例: 5_400_000 → "1時間30分" */
export function formatDuration(ms: number): string {
	const min = Math.round(ms / 60_000);
	if (min === 0) return `${Math.round(ms / 1000)}秒`;
	const d = Math.floor(min / 1440);
	const h = Math.floor((min % 1440) / 60);
	const m = min % 60;
	return [d && `${d}日`, h && `${h}時間`, m && `${m}分`]
		.filter(Boolean)
		.join("");
}
