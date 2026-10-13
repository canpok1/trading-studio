import { expect, test } from "bun:test";
import { createTestApp } from "./test-app";

test("GET /api/version はビルド日時を返す", async () => {
	const { app } = createTestApp({ appBuiltAt: 1790467800000 });
	const res = await app.request("/api/version");
	expect(await res.json()).toEqual({ builtAt: 1790467800000 });
	const dev = createTestApp().app;
	expect(await (await dev.request("/api/version")).json()).toEqual({
		builtAt: null,
	});
});
