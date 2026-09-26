import { describe, expect, test } from "bun:test";
import { createTestApp } from "./test-app";

describe("/api/health", () => {
	test("DB に接続できれば db: ok を返す", async () => {
		const app = createTestApp({ isDbReachable: () => true }).app;
		const res = await app.request("/api/health");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok", db: "ok" });
	});

	test("DB に接続できなければ db: error を返す", async () => {
		const app = createTestApp({ isDbReachable: () => false }).app;
		expect(await (await app.request("/api/health")).json()).toEqual({
			status: "ok",
			db: "error",
		});
	});
});
