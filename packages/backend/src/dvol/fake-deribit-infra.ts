// E2E 用。Deribit へつながず、時刻から決まる値の1時間足を返す

import type { FetchDvol } from "./dvol-domain";

const HOUR_MS = 3_600_000;
/** 過去分の取り込みで何万本も作らないよう、この長さより前は空にする */
const DEMO_SPAN_MS = 30 * 24 * HOUR_MS;

export function demoDvol({
	now = Date.now,
}: {
	now?: () => number;
} = {}): FetchDvol {
	return async (from, to) => {
		const start = Math.max(from, now() - DEMO_SPAN_MS);
		const bars = [];
		for (let t = Math.ceil(start / HOUR_MS) * HOUR_MS; t <= to; t += HOUR_MS) {
			const close = 5000 + Math.round(Math.sin(t / HOUR_MS / 24) * 500);
			bars.push({
				time: t,
				open: close - 20,
				high: close + 40,
				low: close - 40,
				close,
			});
		}
		return bars;
	};
}
