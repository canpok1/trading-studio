/** @module-tag medium */
import { afterAll, describe, expect, test } from "bun:test";
import { ADVICE_RESPONSE_SCHEMA } from "../advice/prompt-domain";
import { RESPONSE_SCHEMA } from "../news/prompt-domain";
import {
	compatibleModel,
	fetchCompatibleModels,
	routedModel,
	toJsonSchema,
} from "./compatible-infra";
import type { GeminiModel } from "./model-domain";
import { NO_CONNECTION } from "./model-domain";

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
				b: { type: ["integer", "null"], description: "d（0〜）" },
				c: { type: ["string", "null"], enum: ["x", null] },
				d: { type: "array", items: { type: "number" } },
			},
			required: ["a"],
			additionalProperties: false,
		});
	});

	test("採点とアドバイスの形に大文字の型・Gemini だけの項目・Claude が受け付けない項目が残らない", () => {
		const objects = (v: unknown): Record<string, unknown>[] =>
			typeof v !== "object" || v === null
				? []
				: [
						...((v as { type?: unknown }).type === "object"
							? [v as Record<string, unknown>]
							: []),
						...Object.values(v).flatMap(objects),
					];
		for (const s of [RESPONSE_SCHEMA, ADVICE_RESPONSE_SCHEMA]) {
			const converted = toJsonSchema(s);
			const out = JSON.stringify(converted);
			expect(out).not.toMatch(/"(OBJECT|STRING|INTEGER|NUMBER|ARRAY|BOOLEAN)"/);
			expect(out).not.toContain("propertyOrdering");
			expect(out).not.toContain("nullable");
			expect(out).not.toMatch(/"(minimum|maximum)"/);
			const objs = objects(converted);
			expect(objs.length).toBeGreaterThan(0);
			for (const o of objs) expect(o.additionalProperties).toBe(false);
		}
		expect(JSON.stringify(toJsonSchema(RESPONSE_SCHEMA))).toContain(
			"-100〜100",
		);
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
						json_schema: {
							name: "response",
							schema: { type: "object", additionalProperties: false },
						},
					},
				},
			},
		]);
	});

	test("構造化出力を 400 で断られたら形を文章で渡して問い合わせ直し、次からは最初からそうする", async () => {
		received.length = 0;
		let calls = 0;
		reply = () =>
			++calls === 1
				? json(
						{
							error: {
								message:
									"output_config.format.schema: For 'object' type, 'additionalProperties' must be explicitly set to false",
							},
						},
						400,
					)
				: json({ choices: [{ message: { content: '{"ok":1}' } }] });
		const m = compatibleModel(() => ({ baseUrl, apiKey: null }));
		expect(await m.generate("claude", "p", { type: "OBJECT" })).toEqual({
			ok: 1,
		});
		await m.generate("claude", "p", { type: "OBJECT" });
		const bodies = received.map((r) => r.body as Record<string, unknown>);
		expect(bodies.map((b) => "response_format" in b)).toEqual([
			true,
			false,
			false,
		]);
		const content = (
			bodies[1]?.messages as { content: string }[] | undefined
		)?.[0]?.content;
		expect(content).toStartWith("p\n\n# 出力の形");
		expect(content).toContain('{"type":"object","additionalProperties":false}');
		// 断られたのはそのモデルだけ
		await m.generate("other", "p", {});
		expect(received[3]?.body).toHaveProperty("response_format");
	});

	test("問い合わせ直しても失敗なら理由を投げ、次も構造化出力から試す", async () => {
		received.length = 0;
		reply = () => json({ error: { message: "bad model" } }, 400);
		const m = compatibleModel(() => ({ baseUrl, apiKey: null }));
		await expect(m.generate("x", "p", {})).rejects.toThrow(
			"OpenAI 互換 API 400: bad model",
		);
		await expect(m.generate("x", "p", {})).rejects.toThrow("bad model");
		expect(
			received.map((r) => "response_format" in (r.body as object)),
		).toEqual([true, false, true, false]);
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
		// 構造化出力を無視して囲みを付けるモデルでも読む
		reply = () =>
			json({ choices: [{ message: { content: '```json\n{"a":1}\n```' } }] });
		expect(await m.generate("m", "p", {})).toEqual({ a: 1 });
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
