// 円・satoshi の整数計算と丸め。丸めはどちらも自分に不利な側に寄せる（結果を甘く見積もらないため）

/** 1 BTC あたりの satoshi */
export const SATOSHI_PER_BTC = 100_000_000;

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

/** 価格（円/BTC）× 数量（satoshi）の金額（円）。買いの支払いは ceil、売りの受け取りは floor で使う */
export function notionalYen(
	price: number,
	quantity: number,
	mode: "floor" | "ceil",
): number {
	assertSafeInteger("price", price);
	assertSafeInteger("quantity", quantity);
	return divide(
		BigInt(price) * BigInt(quantity),
		BigInt(SATOSHI_PER_BTC),
		mode,
	);
}

/** 手数料（円）。価格 × 数量 × 率 を円未満切り上げ */
export function feeYen(
	price: number,
	quantity: number,
	ratePpm: number,
): number {
	assertSafeInteger("price", price);
	assertSafeInteger("quantity", quantity);
	assertSafeInteger("ratePpm", ratePpm);
	return divide(
		BigInt(price) * BigInt(quantity) * BigInt(ratePpm),
		BigInt(SATOSHI_PER_BTC) * BigInt(PPM),
		"ceil",
	);
}

/** 価格を率だけ下げた買い指値（円未満切り捨て）。例: 現在値の 0.1% 下 = limitBuyPriceBelow(price, 1000) */
export function limitBuyPriceBelow(price: number, ratePpm: number): number {
	assertSafeInteger("price", price);
	assertSafeInteger("ratePpm", ratePpm);
	return divide(BigInt(price) * BigInt(PPM - ratePpm), BigInt(PPM), "floor");
}

/** CSV などの小数の価格を円の整数へ（四捨五入） */
export function roundYen(value: number): number {
	return Math.round(value);
}

/** 0 以上の BTC の小数を satoshi の整数へ（四捨五入）。文字列から桁をずらして変換し、2 進小数の誤差を持ち込まない */
export function btcToSatoshi(btc: string): number {
	const m = /^(\d+)(?:\.(\d+))?$/.exec(btc.trim());
	if (!m) {
		throw new RangeError(`BTC の数量として読めない: ${btc}`);
	}
	const [, intPart = "0", frac = ""] = m;
	const head = frac.slice(0, 8).padEnd(8, "0");
	const roundUp = (frac[8] ?? "0") >= "5";
	const value =
		BigInt(intPart) * BigInt(SATOSHI_PER_BTC) +
		BigInt(head) +
		(roundUp ? 1n : 0n);
	const n = Number(value);
	if (!Number.isSafeInteger(n)) {
		throw new RangeError(`BTC の数量が大きすぎる: ${btc}`);
	}
	return n;
}

/** satoshi を BTC の文字列へ（表示用。末尾の 0 は残さない） */
export function satoshiToBtcString(satoshi: number, minDigits = 0): string {
	const sign = satoshi < 0 ? "-" : "";
	const abs = Math.abs(satoshi);
	const int = Math.floor(abs / SATOSHI_PER_BTC);
	let frac = String(abs % SATOSHI_PER_BTC)
		.padStart(8, "0")
		.replace(/0+$/, "");
	if (frac.length < minDigits) {
		frac = frac.padEnd(minDigits, "0");
	}
	return `${sign}${int}${frac ? `.${frac}` : ""}`;
}
