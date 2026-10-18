// Deribit の公開 API から DVOL の1時間足を取る（キー不要）

import type { FetchDvol } from "./dvol-domain";

const URL_BASE =
	"https://www.deribit.com/api/v2/public/get_volatility_index_data";
const FETCH_TIMEOUT_MS = 30_000;

/** 値は年率 % の小数2桁。×100 の整数にする */
const toInt = (v: unknown) => Math.round(Number(v) * 100);

export const deribitDvol: FetchDvol = async (from, to) => {
	const url = `${URL_BASE}?currency=BTC&start_timestamp=${from}&end_timestamp=${to}&resolution=3600`;
	const res = await fetch(url, {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		headers: { "user-agent": "trading-studio (personal use)" },
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const body = (await res.json()) as {
		result?: { data?: unknown };
		error?: { message?: string };
	};
	const data = body.result?.data;
	if (!Array.isArray(data)) {
		throw new Error(body.error?.message ?? "応答の形が違う");
	}
	return data.map((row) => {
		if (!Array.isArray(row) || row.length < 5) {
			throw new Error("応答の形が違う");
		}
		const [time, open, high, low, close] = row as unknown[];
		if (!Number.isSafeInteger(time)) throw new Error("応答の形が違う");
		return {
			time: time as number,
			open: toInt(open),
			high: toInt(high),
			low: toInt(low),
			close: toInt(close),
		};
	});
};
