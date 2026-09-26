// 判断理由などの文言に使う数値の書式

import { satoshiToBtcString } from "./money";

/** 円の3桁区切り（小数は四捨五入）。例: 13488215 → "13,488,215" */
export function formatYen(value: number): string {
	const sign = value < 0 ? "-" : "";
	const digits = String(Math.abs(Math.round(value)));
	return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** BTC の表示。小数3桁までは0で埋める。例: 2000000 → "0.020" */
export function formatBtc(satoshi: number): string {
	return satoshiToBtcString(satoshi, 3);
}
