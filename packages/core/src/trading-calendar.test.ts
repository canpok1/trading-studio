import { describe, expect, test } from "bun:test";
import { COINCHECK } from "./instrument";
import { candleStart } from "./timeframe";
import type { TradingCalendar } from "./trading-calendar";
import { addOpenTime, isOpen, nextOpen } from "./trading-calendar";

const H = 3_600_000;
const DAY = 24 * H;
const JST = 9 * H;
const jst = (s: string) => Date.parse(`${s}+09:00`);

// 休場のある市場の例: 平日の JST 9:00〜15:00 だけ開く
const weekdays: TradingCalendar = {
	dayStart: (t) => Math.floor((t + JST) / DAY) * DAY - JST,
	session(t) {
		let day = weekdays.dayStart(t);
		for (;;) {
			const weekday = new Date(day + JST).getUTCDay();
			const open = day + 9 * H;
			const close = day + 15 * H;
			if (weekday !== 0 && weekday !== 6 && t < close) return { open, close };
			day += DAY;
		}
	},
};

describe("休みなく開く市場（Coincheck）", () => {
	const cal = COINCHECK.calendar;

	test("いつでも取引でき、期限はそのまま進む", () => {
		const t = jst("2026-09-26T03:10:00");
		expect(isOpen(cal, t)).toBe(true);
		expect(nextOpen(cal, t)).toBe(t);
		expect(addOpenTime(cal, t, 3 * DAY)).toBe(t + 3 * DAY);
	});
});

describe("休場のある市場", () => {
	test("取引時間外は閉じていて、次の立会の始まりで開く", () => {
		// 2026-09-26 は土曜
		expect(isOpen(weekdays, jst("2026-09-25T14:59:59"))).toBe(true);
		expect(isOpen(weekdays, jst("2026-09-25T15:00:00"))).toBe(false);
		expect(nextOpen(weekdays, jst("2026-09-25T15:00:00"))).toBe(
			jst("2026-09-28T09:00:00"),
		);
	});

	test("期限は取引時間だけ数える", () => {
		// 金曜 14:00 から 2 時間 → 月曜 10:00
		expect(addOpenTime(weekdays, jst("2026-09-25T14:00:00"), 2 * H)).toBe(
			jst("2026-09-28T10:00:00"),
		);
		// 取引時間外から数えると次の立会の始まりから
		expect(addOpenTime(weekdays, jst("2026-09-26T12:00:00"), H)).toBe(
			jst("2026-09-28T10:00:00"),
		);
	});

	test("足は立会の始まりから区切り、日足は日の区切り", () => {
		expect(candleStart(jst("2026-09-28T10:59:00"), "1h", weekdays)).toBe(
			jst("2026-09-28T10:00:00"),
		);
		expect(candleStart(jst("2026-09-28T12:59:00"), "4h", weekdays)).toBe(
			jst("2026-09-28T09:00:00"),
		);
		expect(candleStart(jst("2026-09-28T14:00:00"), "1d", weekdays)).toBe(
			jst("2026-09-28T00:00:00"),
		);
	});
});
