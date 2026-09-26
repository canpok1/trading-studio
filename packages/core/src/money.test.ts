import { describe, expect, test } from "bun:test";
import {
	btcToSatoshi,
	feeYen,
	limitBuyPriceBelow,
	notionalYen,
	percentToPpm,
	roundYen,
	satoshiToBtcString,
} from "./money";

describe("notionalYen", () => {
	test("割り切れれば丸めない", () => {
		// 1,000 万円 × 0.02 BTC = 20 万円
		expect(notionalYen(10_000_000, 2_000_000, "floor")).toBe(200_000);
		expect(notionalYen(10_000_000, 2_000_000, "ceil")).toBe(200_000);
	});

	test("端数は floor なら切り捨て、ceil なら切り上げ", () => {
		// 13,500,001 × 0.00000003 BTC = 0.40500003 円
		expect(notionalYen(13_500_001, 3, "floor")).toBe(0);
		expect(notionalYen(13_500_001, 3, "ceil")).toBe(1);
	});

	test("整数でない値は受け付けない", () => {
		expect(() => notionalYen(1.5, 1, "floor")).toThrow(RangeError);
	});
});

describe("feeYen", () => {
	test("円未満は切り上げる", () => {
		// 13,500,000 × 0.001 BTC × 0.1% = 13.5 円 → 14 円
		expect(feeYen(13_500_000, 100_000, 1000)).toBe(14);
	});

	test("小数の率で起きる誤差で切り上がらない", () => {
		// 10,000,000 × 0.01 BTC × 0.1% = 100 円ちょうど。0.001 を小数で掛けると 100.00000000000001 になる
		expect(feeYen(10_000_000, 1_000_000, 1000)).toBe(100);
	});

	test("2^53 を超える掛け算でも誤差が出ない", () => {
		// 13,500,001 × 10.00000001 BTC × 0.1% = 135,000.010135... 円。Number で掛けると下の桁を失う
		expect(feeYen(13_500_001, 1_000_000_001, 1000)).toBe(135_001);
	});

	test("率 0 なら 0", () => {
		expect(feeYen(13_500_000, 100_000, 0)).toBe(0);
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

describe("roundYen", () => {
	test("四捨五入する", () => {
		expect(roundYen(13_500_000.4)).toBe(13_500_000);
		expect(roundYen(13_500_000.5)).toBe(13_500_001);
	});
});

describe("btcToSatoshi", () => {
	test("小数を satoshi へ", () => {
		expect(btcToSatoshi("0.02")).toBe(2_000_000);
		expect(btcToSatoshi("1")).toBe(100_000_000);
		expect(btcToSatoshi("12.34567891")).toBe(1_234_567_891);
	});
	test("9 桁目以降は四捨五入する", () => {
		expect(btcToSatoshi("0.000000014")).toBe(1);
		expect(btcToSatoshi("0.000000015")).toBe(2);
	});
	test("読めない値は例外", () => {
		expect(() => btcToSatoshi("abc")).toThrow(RangeError);
		expect(() => btcToSatoshi("-1")).toThrow(RangeError);
		expect(() => btcToSatoshi("")).toThrow(RangeError);
	});
});

describe("satoshiToBtcString", () => {
	test("末尾の 0 を残さない", () => {
		expect(satoshiToBtcString(2_000_000)).toBe("0.02");
		expect(satoshiToBtcString(100_000_000)).toBe("1");
	});
	test("最小桁数を指定できる", () => {
		expect(satoshiToBtcString(2_000_000, 3)).toBe("0.020");
	});
});
