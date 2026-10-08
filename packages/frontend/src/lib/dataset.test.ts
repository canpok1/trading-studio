import { describe, expect, test } from "bun:test";
import { datasetName, signedPercent } from "./dataset";

const jst = (s: string) => Date.parse(`${s}+09:00`);

describe("datasetName", () => {
	test("同じ年なら終わりの月だけ書く", () => {
		expect(
			datasetName({
				from: jst("2026-08-01T00:00:00"),
				to: jst("2026-10-01T00:00:00"),
				regime: "up",
			}),
		).toBe("2026/08〜09 上昇相場");
	});

	test("年をまたげば年も書く", () => {
		expect(
			datasetName({
				from: jst("2025-12-01T00:00:00"),
				to: jst("2026-02-01T00:00:00"),
				regime: "volatile",
			}),
		).toBe("2025/12〜2026/01 乱高下相場");
	});
});

test("signedPercent", () => {
	expect(signedPercent(327_000)).toBe("+32.7%");
	expect(signedPercent(-120_000)).toBe("-12.0%");
	expect(signedPercent(0)).toBe("0.0%");
});
