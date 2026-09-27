// 指標の計算。計算途中は小数を使う（円への丸めは注文価格・約定価格・手数料だけ）

/**
 * 指数移動平均。最初の period 本の単純平均を起点にし、それより前は NaN。
 * 起点を単純平均にすると、渡す足の本数が十分に長ければ、どこから計算しても値がほぼ一致する
 */
export function ema(values: readonly number[], period: number): number[] {
	const out = new Array<number>(values.length).fill(Number.NaN);
	if (values.length < period) {
		return out;
	}
	const k = 2 / (period + 1);
	let sum = 0;
	for (let i = 0; i < period; i++) {
		sum += values[i] as number;
	}
	let prev = sum / period;
	out[period - 1] = prev;
	for (let i = period; i < values.length; i++) {
		prev = (values[i] as number) * k + prev * (1 - k);
		out[i] = prev;
	}
	return out;
}

/**
 * RSI（Wilder 方式）。最初の period 本の値動きの単純平均を起点にし、以降は 1/period で平滑化する。
 * period 本目（0 始まり）より前は NaN。上げも下げも無ければ 50
 */
export function rsi(values: readonly number[], period: number): number[] {
	const out = new Array<number>(values.length).fill(Number.NaN);
	if (values.length <= period) {
		return out;
	}
	let gain = 0;
	let loss = 0;
	for (let i = 1; i <= period; i++) {
		const d = (values[i] as number) - (values[i - 1] as number);
		if (d > 0) gain += d;
		else loss -= d;
	}
	gain /= period;
	loss /= period;
	const value = () =>
		loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
	out[period] = value();
	for (let i = period + 1; i < values.length; i++) {
		const d = (values[i] as number) - (values[i - 1] as number);
		gain = (gain * (period - 1) + Math.max(d, 0)) / period;
		loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
		out[i] = value();
	}
	return out;
}
