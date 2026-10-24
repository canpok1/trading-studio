// 市場の取引の暦（ADR 0036）。取引できる時間帯（立会）と日の区切りを市場ごとに持つ

const DAY_MS = 86_400_000;

/** 立会。open 以上 close 未満の時刻に取引できる */
export type Session = { open: number; close: number };

export type TradingCalendar = {
	/** 時刻を含む日の始まり。日足の区切りと、1日の損失上限で日を数える区切りに使う */
	dayStart(time: number): number;
	/** 時刻を含む立会。時刻が取引時間外なら、その後で最初の立会 */
	session(time: number): Session;
};

/** 休みなく取引でき、日の区切りが UTC から offsetMs ずれた 0:00 の暦 */
export function alwaysOpenCalendar(offsetMs: number): TradingCalendar {
	const dayStart = (time: number) =>
		Math.floor((time + offsetMs) / DAY_MS) * DAY_MS - offsetMs;
	return {
		dayStart,
		session(time) {
			const open = dayStart(time);
			return { open, close: open + DAY_MS };
		},
	};
}

export function isOpen(calendar: TradingCalendar, time: number): boolean {
	return calendar.session(time).open <= time;
}

/** 時刻以降で最初に取引できる時刻（取引時間内ならその時刻） */
export function nextOpen(calendar: TradingCalendar, time: number): number {
	return Math.max(time, calendar.session(time).open);
}

/** 時刻から取引時間だけを ms 進めた時刻。注文の期限に使う（休場のあいだは期限が進まない） */
export function addOpenTime(
	calendar: TradingCalendar,
	time: number,
	ms: number,
): number {
	let t = time;
	let rest = ms;
	for (;;) {
		const s = calendar.session(t);
		t = Math.max(t, s.open);
		if (t + rest <= s.close) return t + rest;
		rest -= s.close - t;
		t = s.close;
	}
}
