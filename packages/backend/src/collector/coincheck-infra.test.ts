import { describe, expect, test } from "bun:test";
import { BTC_JPY, ETH_JPY, XRP_JPY } from "@trading-studio/core";
import { coincheckPair, parseRestTrade, parseWsTrade } from "./coincheck-infra";

describe("Coincheck の約定の読み取り", () => {
	test("WebSocket の約定を整数へ変換する", () => {
		expect(
			parseWsTrade(BTC_JPY, [
				"1663318663",
				"2357062",
				"btc_jpy",
				"2820896.0",
				"5.0",
				"sell",
				"1193401",
				"2078767",
				null,
			]),
		).toEqual({
			id: 2357062,
			time: 1663318663000,
			price: 2820896,
			quantity: 500_000_000,
		});
		expect(parseWsTrade(BTC_JPY, ["1", "2", "eth_jpy", "1", "1"])).toBeNull();
	});

	test("公開 API の約定を整数へ変換する。指数表記の数量も読む", () => {
		expect(
			parseRestTrade(BTC_JPY, {
				id: 309672161,
				amount: "7.0e-08",
				rate: "13232405.0",
				pair: "btc_jpy",
				created_at: "2026-09-26T08:12:34.000Z",
			}),
		).toEqual({
			id: 309672161,
			time: Date.UTC(2026, 8, 26, 8, 12, 34),
			price: 13232405,
			quantity: 7,
		});
	});

	test("銘柄ごとの通貨ペアと桁で読む", () => {
		expect([BTC_JPY, ETH_JPY, XRP_JPY].map(coincheckPair)).toEqual([
			"btc_jpy",
			"eth_jpy",
			"xrp_jpy",
		]);
		// XRP は価格が 0.001 円、数量が 0.01 XRP の単位
		expect(
			parseWsTrade(XRP_JPY, [
				"1792845339",
				"310564638",
				"xrp_jpy",
				"201.998",
				"95.05",
				"sell",
			]),
		).toEqual({
			id: 310564638,
			time: 1792845339000,
			price: 201_998,
			quantity: 9_505,
		});
		expect(
			parseRestTrade(ETH_JPY, {
				id: 310564563,
				amount: "0.2",
				rate: "371427.0",
				pair: "eth_jpy",
				created_at: "2026-10-24T12:31:24.000Z",
			}),
		).toEqual({
			id: 310564563,
			time: Date.UTC(2026, 9, 24, 12, 31, 24),
			price: 371_427,
			quantity: 20_000,
		});
		expect(
			parseRestTrade(ETH_JPY, {
				id: 1,
				amount: "1",
				rate: "1",
				pair: "btc_jpy",
				created_at: "2026-10-24T12:31:24.000Z",
			}),
		).toBeNull();
	});
});
