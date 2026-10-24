import { describe, expect, test } from "bun:test";
import { brokerOf, COINCHECK_EXCHANGE } from "./broker";
import { COINCHECK } from "./instrument";

describe("口座の先", () => {
	test("市場から、その市場を売買できる口座の先と手数料率を引く", () => {
		expect(brokerOf(COINCHECK)).toBe(COINCHECK_EXCHANGE);
		expect(brokerOf(COINCHECK).fees).toEqual({ limitPpm: 0, marketPpm: 0 });
	});

	test("口座の先の無い市場は例外にする", () => {
		expect(() => brokerOf({ ...COINCHECK, id: "other" })).toThrow(RangeError);
	});
});
