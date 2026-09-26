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
