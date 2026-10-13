import { describe, expect, test } from "bun:test";
import { parseRestTrade, parseWsTrade } from "./coincheck-infra";

describe("Coincheck の約定の読み取り", () => {
	test("WebSocket の約定を整数へ変換する", () => {
		expect(
			parseWsTrade([
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
		expect(parseWsTrade(["1", "2", "eth_jpy", "1", "1"])).toBeNull();
	});

	test("公開 API の約定を整数へ変換する。指数表記の数量も読む", () => {
		expect(
			parseRestTrade({
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
});
