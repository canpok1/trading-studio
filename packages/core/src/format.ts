// 判断理由などの文言に使う数値の書式

import type { Instrument } from "./instrument";
import { quantityToString } from "./money";

/** 円の3桁区切り（小数は四捨五入）。例: 13488215 → "13,488,215" */
export function formatYen(value: number): string {
	const sign = value < 0 ? "-" : "";
	const digits = String(Math.abs(Math.round(value)));
	return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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
