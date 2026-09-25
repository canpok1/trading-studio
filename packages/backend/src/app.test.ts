import { describe, expect, test } from "bun:test";
import { app } from "./app";

describe("/api/health", () => {
	test("ok を返す", async () => {
		const res = await app.request("/api/health");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});
});
