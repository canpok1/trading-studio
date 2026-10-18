import { afterEach, expect, test } from "bun:test";
import { deribitDvol } from "./deribit-infra";

const real = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = real;
});

function respond(body: unknown, status = 200) {
	const urls: string[] = [];
	globalThis.fetch = (async (url: string) => {
		urls.push(String(url));
		return new Response(JSON.stringify(body), { status });
	}) as unknown as typeof fetch;
	return urls;
}

test("期間と1時間足を指定して取り、値を ×100 の整数にする", async () => {
	const urls = respond({
		result: { data: [[1616630400000, 95.03, 96.09, 94.99, 95.735]] },
	});
	expect(await deribitDvol(1616630400000, 1616634000000)).toEqual([
		{ time: 1616630400000, open: 9503, high: 9609, low: 9499, close: 9574 },
	]);
	expect(urls[0]).toBe(
		"https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=1616630400000&end_timestamp=1616634000000&resolution=3600",
	);
});

test("HTTP のエラー・形の違う応答は理由つきで失敗する", async () => {
	respond({}, 503);
	await expect(deribitDvol(0, 1)).rejects.toThrow("HTTP 503");
	respond({ error: { message: "bad request" } });
	await expect(deribitDvol(0, 1)).rejects.toThrow("bad request");
	respond({ result: { data: [[1, 2]] } });
	await expect(deribitDvol(0, 1)).rejects.toThrow("応答の形が違う");
});
