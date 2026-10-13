// 遅い API と、処理が詰まってサーバーが応答できなかった時間をログに出す。
// 画面の読み込みが遅いとき、どの API か・別の処理に塞がれていたのかを実際のサーバーで見分けるため

import type { MiddlewareHandler } from "hono";

/** この時間以上かかったらログに出す */
export const SLOW_MS = 200;

/** 応答までに SLOW_MS 以上かかった API を、メソッド・パス・時間・状態コードで出す */
export function slowRequestLog(
	log: (line: string) => void = console.warn,
	now: () => number = performance.now.bind(performance),
): MiddlewareHandler {
	return async (c, next) => {
		const start = now();
		await next();
		const ms = Math.round(now() - start);
		if (ms >= SLOW_MS) {
			log(`slow api: ${c.req.method} ${c.req.path} ${ms}ms ${c.res.status}`);
		}
	};
}

/**
 * 一定間隔のタイマーの遅れを測り、SLOW_MS 以上遅れたらログに出す。
 * 遅れている間はどの要求にも応えられないので、API 自体は速いのに画面が待たされるときの原因になる
 */
export function watchEventLoopLag(
	log: (line: string) => void = console.warn,
	intervalMs = 1_000,
): () => void {
	let expected = performance.now() + intervalMs;
	const id = setInterval(() => {
		const t = performance.now();
		const lag = Math.round(t - expected);
		if (lag >= SLOW_MS) log(`event loop blocked: ${lag}ms`);
		expected = t + intervalMs;
	}, intervalMs);
	return () => clearInterval(id);
}
