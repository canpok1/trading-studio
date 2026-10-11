import { afterAll, describe, expect, test } from "bun:test";
import { ADVICE_RESPONSE_SCHEMA } from "../advice/prompt";
import type { GeminiModel } from "../news/gemini";
import { RESPONSE_SCHEMA } from "../news/prompt";
import { createTestApp } from "../test-app";
import {
	compatibleModel,
	fetchCompatibleModels,
	NO_CONNECTION,
	routedModel,
	toJsonSchema,
} from "./compatible";
import { DEMO_COMPATIBLE_MODELS } from "./fake-models";

/** 受けたリクエストを残し、決まった応答を返す OpenAI 互換の偽サーバー */
const received: { path: string; auth: string | null; body: unknown }[] = [];
let reply: (path: string) => Response = () => new Response("{}");
const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const path = new URL(req.url).pathname;
		received.push({
			path,
			auth: req.headers.get("authorization"),
			body: req.method === "POST" ? await req.json() : null,
		});
		return reply(path);
	},
});
afterAll(() => server.stop(true));
const baseUrl = `http://localhost:${server.port}/v1`;
const json = (v: unknown, status = 200) => Response.json(v, { status });

describe("JSON Schema への変換", () => {
	test("型を小文字にし、nullable を null 許容に、Gemini だけの項目を落とす", () => {
		expect(
			toJsonSchema({
				type: "OBJECT",
				propertyOrdering: ["a", "b"],
				properties: {
					a: { type: "STRING", format: "enum", enum: ["x", "y"] },
					b: { type: "INTEGER", nullable: true, minimum: 0, description: "d" },
					c: { type: "STRING", enum: ["x"], nullable: true },
					d: { type: "ARRAY", items: { type: "NUMBER" } },
				},
				required: ["a"],
			}),
		).toEqual({
			type: "object",
			properties: {
				a: { type: "string", enum: ["x", "y"] },
				b: { type: ["integer", "null"], minimum: 0, description: "d" },
				c: { type: ["string", "null"], enum: ["x", null] },
				d: { type: "array", items: { type: "number" } },
			},
			required: ["a"],
		});
	});

	test("採点とアドバイスの形に大文字の型・Gemini だけの項目が残らない", () => {
		for (const s of [RESPONSE_SCHEMA, ADVICE_RESPONSE_SCHEMA]) {
			const out = JSON.stringify(toJsonSchema(s));
			expect(out).not.toMatch(/"(OBJECT|STRING|INTEGER|NUMBER|ARRAY|BOOLEAN)"/);
			expect(out).not.toContain("propertyOrdering");
			expect(out).not.toContain("nullable");
		}
	});
});

describe("OpenAI 互換のモデル", () => {
	test("Chat Completions へ構造化出力つきで送り、応答の JSON を返す", async () => {
		received.length = 0;
		reply = () => json({ choices: [{ message: { content: '{"ok":1}' } }] });
		const m = compatibleModel(() => ({ baseUrl, apiKey: "k" }));
		expect(
			await m.generate("anthropic/claude", "p", { type: "OBJECT" }),
		).toEqual({ ok: 1 });
		expect(received).toEqual([
			{
				path: "/v1/chat/completions",
				auth: "Bearer k",
				body: {
					model: "anthropic/claude",
					messages: [{ role: "user", content: "p" }],
					response_format: {
						type: "json_schema",
						json_schema: { name: "response", schema: { type: "object" } },
					},
				},
			},
		]);
	});

	test("キーが無ければ Authorization を付けない", async () => {
		received.length = 0;
		reply = () => json({ choices: [{ message: { content: "{}" } }] });
		await compatibleModel(() => ({ baseUrl, apiKey: null })).generate(
			"m",
			"p",
			{},
		);
		expect(received[0]?.auth).toBeNull();
	});

	test("失敗・空・JSON でない応答は理由を投げる", async () => {
		const m = compatibleModel(() => ({ baseUrl, apiKey: null }));
		reply = () => json({ error: { message: "rate limited" } }, 429);
		await expect(m.generate("m", "p", {})).rejects.toThrow(
			"OpenAI 互換 API 429: rate limited",
		);
		reply = () =>
			json({
				choices: [{ finish_reason: "length", message: { content: "" } }],
			});
		await expect(m.generate("m", "p", {})).rejects.toThrow("length");
		reply = () => json({ choices: [{ message: { content: "not json" } }] });
		await expect(m.generate("m", "p", {})).rejects.toThrow("JSON でない");
	});

	test("接続先が無ければ使えない", async () => {
		const m = compatibleModel(() => null);
		expect(m.unavailable("m")).toBe(NO_CONNECTION);
		await expect(m.generate("m", "p", {})).rejects.toThrow(NO_CONNECTION);
	});

	test("モデル一覧は重複を除いて名前順にし、印を付ける", async () => {
		reply = () =>
			json({ data: [{ id: "b" }, { id: "a" }, { id: "b" }, { id: 1 }] });
		expect(await fetchCompatibleModels({ baseUrl, apiKey: null })).toEqual([
			{ id: "openai:a", label: "a" },
			{ id: "openai:b", label: "b" },
		]);
		reply = () => json({ object: "list" });
		await expect(
			fetchCompatibleModels({ baseUrl, apiKey: null }),
		).rejects.toThrow("形が違う");
	});
});

describe("接続先の振り分け", () => {
	const calls: string[] = [];
	const fake = (name: string, reason: string | null): GeminiModel => ({
		unavailable: (id) => (reason ? `${reason}:${id}` : null),
		async generate(id) {
			calls.push(`${name}:${id}`);
			return {};
		},
	});
	const m = routedModel(fake("gemini", null), fake("compatible", "no"));

	test("印の付いたモデルは OpenAI 互換へ印を外して渡し、他は Gemini へ", async () => {
		await m.generate("gemini-3.5-flash-lite", "p", {});
		await m.generate("openai:anthropic/claude", "p", {});
		expect(calls).toEqual([
			"gemini:gemini-3.5-flash-lite",
			"compatible:anthropic/claude",
		]);
	});

	test("使えるかは選んだモデルの接続先で決まる", () => {
		expect(m.unavailable("gemini-3.5-flash-lite")).toBeNull();
		expect(m.unavailable("openai:x")).toBe("no:x");
	});
});

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
		// キーを渡さなければ保存済みのキーを残す
		const kept = await app.request(
			"/api/ai/compatible",
			put({ baseUrl: "http://other/v1" }),
		);
		expect(await kept.json()).toMatchObject({
			baseUrl: "http://other/v1",
			keyConfigured: true,
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
