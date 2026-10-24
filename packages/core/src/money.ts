// 金額・価格・数量の整数計算と丸め。丸めはどちらも自分に不利な側に寄せる（結果を甘く見積もらないため）

import type { Instrument } from "./instrument";

/** 率は 100 万分の 1 単位の整数で持つ（例: 0.1% = 1000）。小数で持つと 0.001 の誤差で手数料が 1 円ずれる */
export const PPM = 1_000_000;

/** 率の小数（例: 0.1 = 0.1%）を ppm へ。画面の入力から変換するときに使う */
export function percentToPpm(percent: number): number {
	return Math.round(percent * 10_000);
}

export function ppmToPercent(ppm: number): number {
	return ppm / 10_000;
}

function assertSafeInteger(name: string, value: number): void {
	if (!Number.isSafeInteger(value)) {
		throw new RangeError(`${name} は整数で渡す: ${value}`);
	}
}

// 分子・分母とも整数のまま割る。Number の掛け算は 2^53 を超えうるため BigInt で計算する
function divide(
	numerator: bigint,
	denominator: bigint,
	mode: "floor" | "ceil",
): number {
	const q = numerator / denominator;
	const r = numerator % denominator;
	if (r === 0n) {
		return Number(q);
	}
	// 分子・分母とも 0 以上で使うので、BigInt の切り捨て（0 方向）は floor と同じ
	return Number(mode === "ceil" ? q + 1n : q);
}

// 価格 × 数量を金額の最小単位へ直すときの掛ける数と割る数
function notionalScale(instrument: Instrument): {
	multiplier: bigint;
	divisor: bigint;
} {
	return {
		multiplier: 10n ** BigInt(instrument.currency.decimals),
		divisor:
			10n ** BigInt(instrument.priceDecimals + instrument.quantityDecimals),
	};
}

/** 価格 × 数量の金額。買いの支払いは ceil、売りの受け取りは floor で使う */
export function notional(
	instrument: Instrument,
	price: number,
	quantity: number,
	mode: "floor" | "ceil",
): number {
	assertSafeInteger("price", price);
	assertSafeInteger("quantity", quantity);
	const { multiplier, divisor } = notionalScale(instrument);
	return divide(BigInt(price) * BigInt(quantity) * multiplier, divisor, mode);
}

/** 金額で買える数量。価格 × 数量（切り上げ）が金額を超えない最大の数量を、売買単位で切り捨てる */
export function quantityForAmount(
	instrument: Instrument,
	price: number,
	amount: number,
): number {
	assertSafeInteger("price", price);
	assertSafeInteger("amount", amount);
	if (price <= 0 || amount <= 0) return 0;
	const { multiplier, divisor } = notionalScale(instrument);
	const max = divide(
		BigInt(amount) * divisor,
		BigInt(price) * multiplier,
		"floor",
	);
	const unit = instrument.tradingUnit;
	return Math.floor(max / unit) * unit;
}

/** 手数料。価格 × 数量 × 率 を金額の最小単位未満切り上げ */
export function feeAmount(
	instrument: Instrument,
	price: number,
	quantity: number,
	ratePpm: number,
): number {
	assertSafeInteger("price", price);
	assertSafeInteger("quantity", quantity);
	assertSafeInteger("ratePpm", ratePpm);
	const { multiplier, divisor } = notionalScale(instrument);
	return divide(
		BigInt(price) * BigInt(quantity) * BigInt(ratePpm) * multiplier,
		divisor * BigInt(PPM),
		"ceil",
	);
}

/** 価格を率だけ下げた買い指値（価格の最小単位未満切り捨て）。例: 現在値の 0.1% 下 = limitBuyPriceBelow(price, 1000) */
export function limitBuyPriceBelow(price: number, ratePpm: number): number {
	assertSafeInteger("price", price);
	assertSafeInteger("ratePpm", ratePpm);
	return divide(BigInt(price) * BigInt(PPM - ratePpm), BigInt(PPM), "floor");
}

/** 0 以上の数量の小数を最小単位の整数へ（四捨五入）。文字列から桁をずらして変換し、2 進小数の誤差を持ち込まない */
export function parseQuantity(instrument: Instrument, text: string): number {
	const digits = instrument.quantityDecimals;
	const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
	if (!m) {
		throw new RangeError(
			`${instrument.quantityUnit} の数量として読めない: ${text}`,
		);
	}
	const [, intPart = "0", frac = ""] = m;
	const head = frac.slice(0, digits).padEnd(digits, "0");
	const roundUp = (frac[digits] ?? "0") >= "5";
	const value =
		BigInt(intPart) * 10n ** BigInt(digits) +
		BigInt(head || "0") +
		(roundUp ? 1n : 0n);
	const n = Number(value);
	if (!Number.isSafeInteger(n)) {
		throw new RangeError(
			`${instrument.quantityUnit} の数量が大きすぎる: ${text}`,
		);
	}
	return n;
}

// 最小単位の整数を、小数 digits 桁の文字列へ（末尾の 0 は minDigits 桁まで残す）
function decimalString(
	value: number,
	digits: number,
	minDigits: number,
): string {
	const scale = 10 ** digits;
	const sign = value < 0 ? "-" : "";
	const abs = Math.abs(value);
	const int = Math.floor(abs / scale);
	let frac = digits > 0 ? String(abs % scale).padStart(digits, "0") : "";
	frac = frac.replace(/0+$/, "");
	if (frac.length < minDigits) {
		frac = frac.padEnd(minDigits, "0");
	}
	return `${sign}${int}${frac ? `.${frac}` : ""}`;
}

/** 最小単位の数量を小数の文字列へ（表示用。末尾の 0 は残さない） */
export function quantityToString(
	instrument: Instrument,
	quantity: number,
	minDigits = 0,
): string {
	return decimalString(quantity, instrument.quantityDecimals, minDigits);
}

/** 最小単位の価格を通貨での小数の文字列へ（末尾の 0 は残さない） */
export function priceToString(instrument: Instrument, price: number): string {
	return decimalString(price, instrument.priceDecimals, 0);
}

/**
 * 保有の含み損益。手数料を含めず、今の価格で評価する。
 * 保有が無いか、買値か今の価格が分からなければ null
 */
export function unrealizedPnl(
	instrument: Instrument,
	quantity: number,
	entryPrice: number | null,
	price: number | null,
): number | null {
	if (quantity <= 0 || entryPrice === null || price === null) return null;
	const { multiplier, divisor } = notionalScale(instrument);
	// 買値は平均で小数になりうるので BigInt にせず浮動小数で計算する
	return Math.round(
		((price - entryPrice) * quantity * Number(multiplier)) / Number(divisor),
	);
}
