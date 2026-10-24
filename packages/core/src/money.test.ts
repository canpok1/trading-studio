import { describe, expect, test } from "bun:test";
import type { Instrument } from "./instrument";
import { BTC_JPY, JPY, toPriceUnits } from "./instrument";
import {
	feeAmount,
	limitBuyPriceBelow,
	notional,
	parseQuantity,
	percentToPpm,
	quantityForAmount,
	quantityToString,
	unrealizedPnl,
} from "./money";

describe("notional", () => {
	test("割り切れれば丸めない", () => {
		// 1,000 万円 × 0.02 BTC = 20 万円
		expect(notional(BTC_JPY, 10_000_000, 2_000_000, "floor")).toBe(200_000);
		expect(notional(BTC_JPY, 10_000_000, 2_000_000, "ceil")).toBe(200_000);
	});

	test("端数は floor なら切り捨て、ceil なら切り上げ", () => {
		// 13,500,001 × 0.00000003 BTC = 0.40500003 円
		expect(notional(BTC_JPY, 13_500_001, 3, "floor")).toBe(0);
		expect(notional(BTC_JPY, 13_500_001, 3, "ceil")).toBe(1);
	});

	test("整数でない値は受け付けない", () => {
		expect(() => notional(BTC_JPY, 1.5, 1, "floor")).toThrow(RangeError);
	});
});

describe("feeAmount", () => {
	test("円未満は切り上げる", () => {
		// 13,500,000 × 0.001 BTC × 0.1% = 13.5 円 → 14 円
		expect(feeAmount(BTC_JPY, 13_500_000, 100_000, 1000)).toBe(14);
	});

	test("小数の率で起きる誤差で切り上がらない", () => {
		// 10,000,000 × 0.01 BTC × 0.1% = 100 円ちょうど。0.001 を小数で掛けると 100.00000000000001 になる
		expect(feeAmount(BTC_JPY, 10_000_000, 1_000_000, 1000)).toBe(100);
	});

	test("2^53 を超える掛け算でも誤差が出ない", () => {
		// 13,500,001 × 10.00000001 BTC × 0.1% = 135,000.010135... 円。Number で掛けると下の桁を失う
		expect(feeAmount(BTC_JPY, 13_500_001, 1_000_000_001, 1000)).toBe(135_001);
	});

	test("率 0 なら 0", () => {
		expect(feeAmount(BTC_JPY, 13_500_000, 100_000, 0)).toBe(0);
	});
});

describe("limitBuyPriceBelow", () => {
	test("率だけ下げて円未満を切り捨てる", () => {
		// 13,500,005 × 0.999 = 13,486,504.995 → 13,486,504
		expect(limitBuyPriceBelow(13_500_005, 1000)).toBe(13_486_504);
	});
	test("割り切れれば丸めない", () => {
		expect(limitBuyPriceBelow(10_000_000, 1000)).toBe(9_990_000);
	});
});

describe("percentToPpm", () => {
	test("0.1% は 1000", () => {
		expect(percentToPpm(0.1)).toBe(1000);
		expect(percentToPpm(0.15)).toBe(1500);
	});
});

describe("toPriceUnits", () => {
	test("四捨五入する", () => {
		expect(toPriceUnits(BTC_JPY, 13_500_000.4)).toBe(13_500_000);
		expect(toPriceUnits(BTC_JPY, 13_500_000.5)).toBe(13_500_001);
	});
});

describe("parseQuantity", () => {
	test("小数を satoshi へ", () => {
		expect(parseQuantity(BTC_JPY, "0.02")).toBe(2_000_000);
		expect(parseQuantity(BTC_JPY, "1")).toBe(100_000_000);
		expect(parseQuantity(BTC_JPY, "12.34567891")).toBe(1_234_567_891);
	});
	test("9 桁目以降は四捨五入する", () => {
		expect(parseQuantity(BTC_JPY, "0.000000014")).toBe(1);
		expect(parseQuantity(BTC_JPY, "0.000000015")).toBe(2);
	});
	test("読めない値は例外", () => {
		expect(() => parseQuantity(BTC_JPY, "abc")).toThrow(RangeError);
		expect(() => parseQuantity(BTC_JPY, "-1")).toThrow(RangeError);
		expect(() => parseQuantity(BTC_JPY, "")).toThrow(RangeError);
	});
});

describe("quantityToString", () => {
	test("末尾の 0 を残さない", () => {
		expect(quantityToString(BTC_JPY, 2_000_000)).toBe("0.02");
		expect(quantityToString(BTC_JPY, 100_000_000)).toBe("1");
	});
	test("最小桁数を指定できる", () => {
		expect(quantityToString(BTC_JPY, 2_000_000, 3)).toBe("0.020");
	});
});

describe("含み損益", () => {
	test("含み損益は保有を今の価格で評価し、保有か価格が無ければ出さない", () => {
		// 0.01 BTC を 1,000万円で買い、今 1,050万円
		expect(unrealizedPnl(BTC_JPY, 1_000_000, 10_000_000, 10_500_000)).toBe(
			5_000,
		);
		expect(unrealizedPnl(BTC_JPY, 1_000_000, 10_000_000, 9_900_000)).toBe(
			-1_000,
		);
		expect(unrealizedPnl(BTC_JPY, 0, null, 10_500_000)).toBeNull();
		expect(unrealizedPnl(BTC_JPY, 1_000_000, 10_000_000, null)).toBeNull();
	});
});

describe("BTC 以外の単位", () => {
	// 価格はセント、数量は1株単位
	const usStock: Instrument = {
		id: "us:aapl",
		marketId: "us",
		symbol: "AAPL",
		currency: { code: "USD", unit: "ドル", decimals: 2 },
		priceDecimals: 2,
		quantityDecimals: 0,
		quantityUnit: "株",
		quantityMinDigits: 0,
		tradingUnit: 1,
		minOrderQuantity: 1,
	};
	// 価格は0.1円刻み、数量は1株単位、売買単位は100株
	const jpStock: Instrument = {
		id: "tse:7203",
		marketId: "tse",
		symbol: "7203",
		currency: JPY,
		priceDecimals: 1,
		quantityDecimals: 0,
		quantityUnit: "株",
		quantityMinDigits: 0,
		tradingUnit: 100,
		minOrderQuantity: 100,
	};

	test("金額は通貨の最小単位で出す", () => {
		// $123.45 × 10 株 = $1,234.50
		expect(notional(usStock, 12_345, 10, "floor")).toBe(123_450);
		// 2,000.5 円 × 100 株 = 200,050 円
		expect(notional(jpStock, 20_005, 100, "floor")).toBe(200_050);
		// 2,000.5 円 × 1 株 = 2,000.5 円
		expect(notional(jpStock, 20_005, 1, "floor")).toBe(2_000);
		expect(notional(jpStock, 20_005, 1, "ceil")).toBe(2_001);
	});

	test("手数料と含み損益も同じ単位で出す", () => {
		// $123.45 × 10 株 × 0.495% = $6.110775 → 612 セント
		expect(feeAmount(usStock, 12_345, 10, 4_950)).toBe(612);
		// (2,010.0 − 2,000.5) 円 × 100 株 = 950 円
		expect(unrealizedPnl(jpStock, 100, 20_005, 20_100)).toBe(950);
	});

	test("金額で買える量を売買単位で切り捨てる", () => {
		// $1,000 ÷ $123.45 = 8.1 株 → 8 株
		expect(quantityForAmount(usStock, 12_345, 100_000)).toBe(8);
		// 1,000,000 円 ÷ 2,000.5 円 = 499.8 株 → 400 株
		expect(quantityForAmount(jpStock, 20_005, 1_000_000)).toBe(400);
		// 100,000 円 ÷ 10,000,000 円 = 0.01 BTC
		expect(quantityForAmount(BTC_JPY, 10_000_000, 100_000)).toBe(1_000_000);
		// 1 BTC = 3 億円なら 1 satoshi は 3 円。1 円では買えない
		expect(quantityForAmount(BTC_JPY, 300_000_000, 1)).toBe(0);
	});

	test("価格と数量を最小単位へ直す", () => {
		expect(toPriceUnits(usStock, 123.45)).toBe(12_345);
		expect(parseQuantity(usStock, "10")).toBe(10);
		expect(quantityToString(usStock, 10)).toBe("10");
	});
});
