import { describe, expect, test } from "bun:test";
import {
	CSV_HEADER,
	formatCandleCsvRow,
	formatJstRfc3339,
	parseCandleCsv,
	parseRfc3339,
} from "./csv";

describe("parseRfc3339", () => {
	test("オフセット付き・Z・小数秒なしを読む", () => {
		expect(parseRfc3339("2026-09-26T12:00:01.000+09:00")).toBe(
			Date.UTC(2026, 8, 26, 3, 0, 1),
		);
		expect(parseRfc3339("2026-09-26T03:00:01Z")).toBe(
			Date.UTC(2026, 8, 26, 3, 0, 1),
		);
		expect(parseRfc3339("2026-09-26 03:00:01.5-01:30")).toBe(
			Date.UTC(2026, 8, 26, 4, 30, 1, 500),
		);
	});

	test("オフセットの無い日時・存在しない日付は読まない", () => {
		expect(parseRfc3339("2026-09-26T12:00:01")).toBeNull();
		expect(parseRfc3339("2026-08-01 05:11:00")).toBeNull();
		expect(parseRfc3339("2026-02-30T00:00:00Z")).toBeNull();
		expect(parseRfc3339("日時")).toBeNull();
	});
});

const HEAD = "日時,始値,高値,安値,終値,出来高";

describe("parseCandleCsv", () => {
	test("ヘッダーを読み飛ばし、価格は円へ四捨五入、出来高は satoshi にする", () => {
		const r = parseCandleCsv(
			`${HEAD}\n2026-09-26T12:00:00+09:00,100.4,110.5,90,105,0.5\n`,
			"1m",
		);
		expect(r).toEqual({
			ok: true,
			candles: [
				{
					time: Date.UTC(2026, 8, 26, 3),
					open: 100,
					high: 111,
					low: 90,
					close: 105,
					volume: 50_000_000,
				},
			],
			duplicateRows: 0,
			totalRows: 1,
		});
	});

	test("ヘッダーが無くても読める。日時は足の開始時刻へ切り下げ、古い順に並べる", () => {
		const r = parseCandleCsv(
			"2026-09-26T12:05:30+09:00,1,1,1,1,0\n2026-09-26T12:00:01.000+09:00,2,2,2,2,0",
			"5m",
		);
		if (!r.ok) throw new Error("ok のはず");
		expect(r.candles.map((c) => c.time)).toEqual([
			Date.UTC(2026, 8, 26, 3, 0),
			Date.UTC(2026, 8, 26, 3, 5),
		]);
	});

	test("ファイル内で同じ日時の行は最初の行を使い、件数を返す", () => {
		const r = parseCandleCsv(
			"2026-09-26T12:00:00Z,1,1,1,1,0\n2026-09-26T12:00:00Z,2,2,2,2,0",
			"1m",
		);
		expect(r.ok && r.duplicateRows).toBe(1);
		expect(r.ok && r.candles[0]?.open).toBe(1);
	});

	test("1行でも不正なら足を返さず、行番号・該当行・理由を返す", () => {
		const r = parseCandleCsv(
			[
				HEAD,
				"2026-09-26T12:00:00+09:00,1,1,1,1,0",
				"2026-09-26 12:01:00,1,1,1,1,0",
				"2026-09-26T12:02:00+09:00,1,1,1",
				"2026-09-26T12:03:00+09:00,1,0.1,1,1,0",
				"2026-09-26T12:04:00+09:00,1,2,1,1,x",
			].join("\n"),
			"1m",
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errorCount).toBe(4);
		expect(r.errors.map((e) => e.line)).toEqual([3, 4, 5, 6]);
		expect(r.errors[0]).toEqual({
			line: 3,
			content: "2026-09-26 12:01:00,1,1,1,1,0",
			message: "日時が読めない（タイムゾーンの無い日時は受け付けない）",
		});
	});

	test("2行目以降の日時が読めなければヘッダー扱いにしない", () => {
		const r = parseCandleCsv(`${HEAD}\n${HEAD}`, "1m");
		expect(r.ok).toBe(false);
	});

	test("データの行が無ければエラー", () => {
		expect(parseCandleCsv(HEAD, "1m").ok).toBe(false);
	});
});

describe("formatCandleCsvRow", () => {
	test("日時は JST、出来高は BTC で書き、parseCandleCsv で読み戻せる", () => {
		const candles = [
			{
				time: Date.UTC(2026, 8, 25, 15),
				open: 17_000_000,
				high: 17_010_000,
				low: 16_990_000,
				close: 17_005_000,
				volume: 12_345_678,
			},
			{
				time: Date.UTC(2026, 8, 25, 15, 1),
				open: 17_005_000,
				high: 17_005_000,
				low: 17_005_000,
				close: 17_005_000,
				volume: 0,
			},
		];
		expect(formatJstRfc3339(candles[0]?.time as number)).toBe(
			"2026-09-26T00:00:00.000+09:00",
		);
		expect(formatCandleCsvRow(candles[0] as (typeof candles)[0])).toBe(
			"2026-09-26T00:00:00.000+09:00,17000000,17010000,16990000,17005000,0.12345678",
		);
		const text = [CSV_HEADER, ...candles.map(formatCandleCsvRow)].join("\n");
		const r = parseCandleCsv(text, "1m");
		expect(r.ok && r.candles).toEqual(candles);
	});
});
