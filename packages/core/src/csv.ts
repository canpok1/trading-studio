// 過去データの CSV の読み取りと検証

import { btcToSatoshi, roundYen } from "./money";
import type { Timeframe } from "./timeframe";
import { candleStart } from "./timeframe";
import type { Candle } from "./types";

export const CSV_EXPECTED_FORMAT =
	"日時,始値,高値,安値,終値,出来高（日時は 2026-09-26T12:00:01.000+09:00 のようにタイムゾーン付き。Z も可、小数秒は省略可）";

export type CsvRowError = {
	/** 1 始まりの行番号 */
	line: number;
	content: string;
	message: string;
};

export type CsvParseResult =
	| {
			ok: true;
			candles: Candle[];
			/** ファイル内で同じ日時が重なった行の数（最初の行を使う） */
			duplicateRows: number;
			/** データの行数（ヘッダー・空行を除く） */
			totalRows: number;
	  }
	| { ok: false; errors: CsvRowError[]; errorCount: number; totalRows: number };

/** 返すエラーの上限。全件の数は errorCount で返す */
const MAX_ERRORS = 100;

// RFC 3339。T の代わりに空白も許す。秒は必須、小数秒は任意、オフセットは必須
const DATETIME =
	/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

/** RFC 3339 の日時をエポックミリ秒へ。読めなければ null */
export function parseRfc3339(value: string): number | null {
	const m = DATETIME.exec(value.trim());
	if (!m) return null;
	const [, y, mo, d, h, mi, s, frac = "", zone = "Z"] = m;
	const year = Number(y);
	const month = Number(mo);
	const day = Number(d);
	const hour = Number(h);
	const minute = Number(mi);
	const second = Number(s);
	if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
		return null;
	}
	const base = Date.UTC(year, month - 1, day, hour, minute, second);
	// 2月30日など、存在しない日付は Date.UTC が繰り上げるので弾く
	if (new Date(base).getUTCDate() !== day) return null;
	const ms = frac ? Math.floor(Number(`0${frac}`) * 1000) : 0;
	let offset = 0;
	if (zone.toUpperCase() !== "Z") {
		const sign = zone[0] === "-" ? -1 : 1;
		const oh = Number(zone.slice(1, 3));
		const om = Number(zone.slice(4, 6));
		if (oh > 23 || om > 59) return null;
		offset = sign * (oh * 60 + om) * 60_000;
	}
	return base + ms - offset;
}

const DECIMAL = /^\d+(\.\d+)?$/;

function parsePrice(v: string): number | null {
	const t = v.trim();
	if (!DECIMAL.test(t)) return null;
	const n = roundYen(Number(t));
	return n > 0 && Number.isSafeInteger(n) ? n : null;
}

/**
 * CSV を読んで足にする。1行でも不正なら足を返さず、行番号付きのエラーを返す。
 * 日時は足の開始時刻へ切り下げる（例: 1分足の 12:00:01 は 12:00:00 の足）。
 * 1行目の日時が読めなければヘッダーとして読み飛ばす
 */
export function parseCandleCsv(
	text: string,
	timeframe: Timeframe,
	onProgress?: (done: number, total: number) => void,
): CsvParseResult {
	const lines = text.split(/\r?\n/);
	const total = lines.filter((l) => l.trim() !== "").length;
	const errors: CsvRowError[] = [];
	let errorCount = 0;
	let rows = 0;
	const byTime = new Map<number, Candle>();
	let duplicateRows = 0;
	const fail = (line: number, content: string, message: string) => {
		errorCount++;
		if (errors.length < MAX_ERRORS) errors.push({ line, content, message });
	};

	let seenFirst = false;
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i] as string;
		if (raw.trim() === "") continue;
		const lineNo = i + 1;
		const cols = raw.split(",").map((c) => c.trim().replace(/^"(.*)"$/, "$1"));
		const time = parseRfc3339(cols[0] ?? "");
		if (!seenFirst) {
			seenFirst = true;
			if (time === null) continue; // ヘッダー
		}
		rows++;
		if (onProgress && rows % 10_000 === 0) onProgress(rows, total);
		if (cols.length !== 6) {
			fail(lineNo, raw, `列の数が ${cols.length} 個（6 個必要）`);
			continue;
		}
		if (time === null) {
			fail(
				lineNo,
				raw,
				"日時が読めない（タイムゾーンの無い日時は受け付けない）",
			);
			continue;
		}
		const [open, high, low, close] = cols.slice(1, 5).map(parsePrice);
		if (
			open === null ||
			high === null ||
			low === null ||
			close === null ||
			open === undefined ||
			high === undefined ||
			low === undefined ||
			close === undefined
		) {
			fail(lineNo, raw, "価格が読めない（0 より大きい数値が必要）");
			continue;
		}
		if (high < Math.max(open, close, low) || low > Math.min(open, close)) {
			fail(lineNo, raw, "高値・安値が始値・終値と矛盾している");
			continue;
		}
		let volume: number;
		try {
			volume = btcToSatoshi(cols[5] ?? "");
		} catch {
			fail(lineNo, raw, "出来高が読めない（0 以上の数値が必要）");
			continue;
		}
		const start = candleStart(time, timeframe);
		if (byTime.has(start)) {
			duplicateRows++;
			continue;
		}
		byTime.set(start, { time: start, open, high, low, close, volume });
	}
	onProgress?.(rows, total);
	if (errorCount > 0) {
		return { ok: false, errors, errorCount, totalRows: rows };
	}
	if (rows === 0) {
		return {
			ok: false,
			errors: [{ line: 1, content: "", message: "データの行が無い" }],
			errorCount: 1,
			totalRows: 0,
		};
	}
	const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
	return { ok: true, candles, duplicateRows, totalRows: rows };
}
