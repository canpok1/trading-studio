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

/**
 * ボリンジャーバンド。中央は単純移動平均、幅は直近 period 本の標準偏差（母標準偏差）の sigma 倍。
 * period − 1 本目（0 始まり）より前は NaN
 */
export function bollinger(
	values: readonly number[],
	period: number,
	sigma: number,
): { middle: number[]; upper: number[]; lower: number[] } {
	const middle = new Array<number>(values.length).fill(Number.NaN);
	const upper = new Array<number>(values.length).fill(Number.NaN);
	const lower = new Array<number>(values.length).fill(Number.NaN);
	for (let i = period - 1; i < values.length; i++) {
		let sum = 0;
		for (let j = i - period + 1; j <= i; j++) sum += values[j] as number;
		const mean = sum / period;
		let sq = 0;
		for (let j = i - period + 1; j <= i; j++) {
			sq += ((values[j] as number) - mean) ** 2;
		}
		const width = Math.sqrt(sq / period) * sigma;
		middle[i] = mean;
		upper[i] = mean + width;
		lower[i] = mean - width;
	}
	return { middle, upper, lower };
}

type Bar = { high: number; low: number; close: number };

/** 真の値幅（TR）。前の足が無い最初の足は NaN */
export function trueRange(candles: readonly Bar[]): number[] {
	return candles.map((c, i) => {
		const prev = candles[i - 1];
		if (!prev) return Number.NaN;
		return Math.max(
			c.high - c.low,
			Math.abs(c.high - prev.close),
			Math.abs(c.low - prev.close),
		);
	});
}

/**
 * ADX（Wilder 方式）。TR・+DM・−DM を period 本で Wilder 平滑して +DI・−DI を出し、DX = 100 × |+DI − −DI| ÷ (+DI + −DI)（分母が 0 なら 0）。
 * ADX は DX の Wilder 平均で、最初の値は最初の period 本の DX の単純平均。2 × period − 1 本目（0 始まり）より前は NaN
 */
export function adx(candles: readonly Bar[], period: number): number[] {
	const out = new Array<number>(candles.length).fill(Number.NaN);
	if (candles.length < 2 * period) {
		return out;
	}
	const tr = trueRange(candles);
	let sTr = 0;
	let sPlus = 0;
	let sMinus = 0;
	let dxSum = 0;
	let prevAdx = 0;
	for (let i = 1; i < candles.length; i++) {
		const c = candles[i] as Bar;
		const prev = candles[i - 1] as Bar;
		const up = c.high - prev.high;
		const down = prev.low - c.low;
		const plus = up > down && up > 0 ? up : 0;
		const minus = down > up && down > 0 ? down : 0;
		// 最初の period 本は合計し、以降は Wilder 平滑（合計の形のまま。DI は比なので平均にしても同じ）
		if (i <= period) {
			sTr += tr[i] as number;
			sPlus += plus;
			sMinus += minus;
		} else {
			sTr = sTr - sTr / period + (tr[i] as number);
			sPlus = sPlus - sPlus / period + plus;
			sMinus = sMinus - sMinus / period + minus;
		}
		if (i < period) continue;
		const plusDi = sTr === 0 ? 0 : (100 * sPlus) / sTr;
		const minusDi = sTr === 0 ? 0 : (100 * sMinus) / sTr;
		const sum = plusDi + minusDi;
		const dx = sum === 0 ? 0 : (100 * Math.abs(plusDi - minusDi)) / sum;
		if (i < 2 * period - 1) {
			dxSum += dx;
		} else if (i === 2 * period - 1) {
			prevAdx = (dxSum + dx) / period;
			out[i] = prevAdx;
		} else {
			prevAdx = (prevAdx * (period - 1) + dx) / period;
			out[i] = prevAdx;
		}
	}
	return out;
}

/**
 * ATR（Wilder 方式）。最初の period 本の TR の単純平均を起点にし、以降は 1/period で平滑化する。
 * TR に前の足が要るので、period 本目（0 始まり）より前は NaN
 */
export function atr(candles: readonly Bar[], period: number): number[] {
	const out = new Array<number>(candles.length).fill(Number.NaN);
	if (candles.length <= period) {
		return out;
	}
	const tr = trueRange(candles);
	let sum = 0;
	for (let i = 1; i <= period; i++) {
		sum += tr[i] as number;
	}
	let prev = sum / period;
	out[period] = prev;
	for (let i = period + 1; i < candles.length; i++) {
		prev = (prev * (period - 1) + (tr[i] as number)) / period;
		out[i] = prev;
	}
	return out;
}
