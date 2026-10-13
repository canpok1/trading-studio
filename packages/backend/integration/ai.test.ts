import { describe, expect, test } from "bun:test";
import { DEMO_COMPATIBLE_MODELS } from "../src/ai/fake-models-infra";
import { NO_CONNECTION } from "../src/ai/model-domain";
import { createTestApp } from "../src/test-app";

describe("OpenAI 互換の接続先の API", () => {
	const put = (body: unknown) => ({
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

	test("URL とキーを保存し、キーは返さない。消すと一覧も取れない", async () => {
		const { app } = createTestApp();
		expect(await (await app.request("/api/ai/compatible")).json()).toEqual({
			baseUrl: null,
			keyConfigured: false,
			keySavedAt: null,
		});
		expect(
			await (await app.request("/api/ai/compatible/models")).json(),
		).toEqual({ ok: false, message: NO_CONNECTION });

		expect((await app.request("/api/ai/compatible", put({}))).status).toBe(400);
		expect(
			(await app.request("/api/ai/compatible", put({ baseUrl: "ftp://x" })))
				.status,
		).toBe(400);
		const saved = await app.request(
			"/api/ai/compatible",
			put({ baseUrl: "http://bifrost:8080/v1/", apiKey: "secret-1" }),
		);
		expect(saved.status).toBe(200);
		const body = await saved.text();
		expect(body).not.toContain("secret-1");
		expect(JSON.parse(body)).toMatchObject({
			baseUrl: "http://bifrost:8080/v1",
			keyConfigured: true,
		});
		// キーを渡さなければ保存済みのキーを残す。URL を変えたら前の接続先のキーは消す
		const kept = await app.request(
			"/api/ai/compatible",
			put({ baseUrl: "http://bifrost:8080/v1" }),
		);
		expect(await kept.json()).toMatchObject({ keyConfigured: true });
		const moved = await app.request(
			"/api/ai/compatible",
			put({ baseUrl: "http://other/v1" }),
		);
		expect(await moved.json()).toEqual({
			baseUrl: "http://other/v1",
			keyConfigured: false,
			keySavedAt: null,
		});

		const models = await (
			await app.request("/api/ai/compatible/models")
		).json();
		expect(models).toEqual({
			ok: true,
			models: DEMO_COMPATIBLE_MODELS.map((id) => ({
				id: `openai:${id}`,
				label: id,
			})),
		});

		const cleared = await app.request("/api/ai/compatible", {
			method: "DELETE",
		});
		expect(await cleared.json()).toEqual({
			baseUrl: null,
			keyConfigured: false,
			keySavedAt: null,
		});
	});

	test("採点とアドバイスで OpenAI 互換のモデルを選べる", async () => {
		const { app } = createTestApp();
		for (const path of ["/api/scoring/model", "/api/advice/model"]) {
			const ok = await app.request(path, put({ model: "openai:openai/gpt-x" }));
			expect(ok.status).toBe(200);
			expect(await ok.json()).toMatchObject({ current: "openai:openai/gpt-x" });
			expect((await app.request(path, put({ model: "openai:" }))).status).toBe(
				400,
			);
			expect(
				(await app.request(path, put({ model: "openai:a b" }))).status,
			).toBe(400);
			expect((await app.request(path, put({ model: "gpt-x" }))).status).toBe(
				400,
			);
		}
	});
});
