import { describe, expect, test } from "bun:test";
import { formatMoney, formatPrice, formatPriceWithUnit } from "./format";
import type { Currency, Instrument } from "./instrument";
import { BTC_JPY, JPY } from "./instrument";

// 小数のある通貨の例: ドル（最小単位はセント）
const USD: Currency = { code: "USD", unit: "ドル", decimals: 2 };
const AAPL: Instrument = {
	...BTC_JPY,
	id: "test:aapl",
	symbol: "AAPL",
	currency: USD,
	priceDecimals: 2,
};

describe("価格と金額の書式", () => {
	test("円は今までどおり3桁区切りの整数", () => {
		expect(formatPrice(BTC_JPY, 13_488_215)).toBe("13,488,215");
		expect(formatPriceWithUnit(BTC_JPY, 13_488_215)).toBe("13,488,215 円");
		expect(formatMoney(JPY, -1_000)).toBe("-1,000 円");
	});

	test("小数のある通貨は最小単位の桁まで出す", () => {
		expect(formatPrice(AAPL, 123_456_7)).toBe("12,345.67");
		expect(formatPriceWithUnit(AAPL, 5)).toBe("0.05 ドル");
		expect(formatMoney(USD, -1_000_00)).toBe("-1,000.00 ドル");
	});

	test("同じ入力なら同じ結果", () => {
		expect(formatPrice(AAPL, 123_456_7)).toBe(formatPrice(AAPL, 123_456_7));
	});
});
