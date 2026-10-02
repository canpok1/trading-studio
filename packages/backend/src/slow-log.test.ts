import { expect, test } from "bun:test";
import { Hono } from "hono";
import { SLOW_MS, slowRequestLog } from "./slow-log";

test("応答に SLOW_MS 以上かかった API だけをログに出す", async () => {
	const lines: string[] = [];
	let t = 0;
	const app = new Hono()
		.use(
			slowRequestLog(
				(l) => lines.push(l),
				() => t,
			),
		)
		.get("/fast", (c) => {
			t += SLOW_MS - 1;
			return c.text("ok");
		})
		.get("/slow", (c) => {
			t += SLOW_MS + 300;
			return c.text("ng", 500);
		});
	await app.request("/fast");
	await app.request("/slow?x=1");
	expect(lines).toEqual([`slow api: GET /slow ${SLOW_MS + 300}ms 500`]);
});
