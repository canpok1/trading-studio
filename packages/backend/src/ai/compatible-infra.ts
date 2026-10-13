// OpenAI 互換 API（Chat Completions）へ問い合わせる。Bifrost などの集約サービス経由で Gemini 以外の AI も使うため（ADR 0027）

import type { Db } from "../db/open";
import type {
	CompatibleConnection,
	GeminiModel,
	ResponseSchema,
} from "./model-domain";
import {
	COMPATIBLE_PREFIX,
	isCompatibleModel,
	NO_CONNECTION,
} from "./model-domain";
import type { CompatibleRepository } from "./repository-domain";
import type { CompatibleModelOption } from "./types-domain";

const TIMEOUT_MS = 60_000;
const LIST_TIMEOUT_MS = 10_000;

const BASE_URL_KEY = "openai_base_url";
const API_KEY_KEY = "openai_api_key";
const API_KEY_SAVED_AT_KEY = "openai_api_key_saved_at";

export class SqliteCompatibleRepository implements CompatibleRepository {
	constructor(private readonly db: Db) {}

	private get sql() {
		return this.db.$client;
	}

	private setting(key: string): string | null {
		return (
			this.sql
				.query<{ value: string }, [string]>(
					"select value from settings where key = ?",
				)
				.get(key)?.value ?? null
		);
	}

	private setSetting(key: string, value: string) {
		this.sql.run(
			"insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
			[key, value],
		);
	}

	connection(): CompatibleConnection | null {
		const baseUrl = this.setting(BASE_URL_KEY);
		return baseUrl ? { baseUrl, apiKey: this.setting(API_KEY_KEY) } : null;
	}

	keySavedAt(): number | null {
		const v = this.setting(API_KEY_SAVED_AT_KEY);
		return v === null ? null : Number(v);
	}

	/** apiKey が undefined なら保存済みのキーを残す。ただし URL が変わったら消す（前の接続先のキーを別の宛先へ送らないため） */
	save(baseUrl: string, apiKey: string | undefined, now: number) {
		this.sql.transaction(() => {
			const urlChanged = this.setting(BASE_URL_KEY) !== baseUrl;
			this.setSetting(BASE_URL_KEY, baseUrl);
			if (apiKey !== undefined) {
				this.setSetting(API_KEY_KEY, apiKey);
				this.setSetting(API_KEY_SAVED_AT_KEY, String(now));
			} else if (urlChanged) {
				this.sql.run("delete from settings where key in (?, ?)", [
					API_KEY_KEY,
					API_KEY_SAVED_AT_KEY,
				]);
			}
		})();
	}

	clear() {
		this.sql.run("delete from settings where key in (?, ?, ?)", [
			BASE_URL_KEY,
			API_KEY_KEY,
			API_KEY_SAVED_AT_KEY,
		]);
	}
}

const headers = (c: CompatibleConnection) => ({
	"content-type": "application/json",
	...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}),
});

const errorMessage = (body: unknown, res: Response) =>
	(body as { error?: { message?: string } } | null)?.error?.message ??
	res.statusText;

/**
 * Gemini の responseSchema の書き方を標準の JSON Schema に直す。
 * Gemini 直結の挙動を変えないため、定義は Gemini の書き方のまま持ち、送るときだけ変換する
 */
export function toJsonSchema(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(toJsonSchema);
	if (typeof schema !== "object" || schema === null) return schema;
	const {
		type,
		nullable,
		format,
		propertyOrdering: _,
		properties,
		items,
		enum: values,
		minimum,
		maximum,
		...rest
	} = schema as Record<string, unknown>;
	const out: Record<string, unknown> = { ...rest };
	if (typeof type === "string") {
		const t = type.toLowerCase();
		out.type = nullable ? [t, "null"] : t;
		// 追加の項目を禁じる。Claude はオブジェクトに false の明示を求める（無いと 400）
		if (t === "object") out.additionalProperties = false;
	}
	// 数の範囲は Claude が受け付けないので説明文へ移す。範囲は受け取った後の検証で確かめる
	if (minimum !== undefined || maximum !== undefined) {
		const range = `${minimum ?? ""}〜${maximum ?? ""}`;
		out.description =
			typeof out.description === "string"
				? `${out.description}（${range}）`
				: `${range} の範囲`;
	}
	if (Array.isArray(values)) out.enum = nullable ? [...values, null] : values;
	// Gemini では enum に format: "enum" を添えるが、JSON Schema の format とは意味が違う
	if (format !== undefined && format !== "enum") out.format = format;
	if (properties !== undefined) {
		out.properties = Object.fromEntries(
			Object.entries(properties as Record<string, unknown>).map(([k, v]) => [
				k,
				toJsonSchema(v),
			]),
		);
	}
	if (items !== undefined) out.items = toJsonSchema(items);
	return out;
}

/**
 * 応答の文から JSON を読む。strict なしでは、構造化出力を無視して ```json の囲みや前置きを付けるモデルがあるので、
 * 最初の { から最後の } までを読む
 */
export function parseJsonText(text: string): unknown {
	const from = text.indexOf("{");
	const to = text.lastIndexOf("}");
	try {
		if (from < 0 || to < from) throw new Error();
		return JSON.parse(text.slice(from, to + 1));
	} catch {
		throw new Error("OpenAI 互換 API の応答が JSON でない");
	}
}

/** OpenAI 互換の接続先へ問い合わせるモデル。model には印を外した名前を渡す */
export function compatibleModel(
	connection: () => CompatibleConnection | null,
	{ timeoutMs = TIMEOUT_MS }: { timeoutMs?: number } = {},
): GeminiModel {
	/** 構造化出力を 400 で断ったモデル（接続先の URL と組で持つ）。次からは最初から形を文章で渡す */
	const schemaRejected = new Set<string>();

	const post = async (
		c: CompatibleConnection,
		body: Record<string, unknown>,
	) => {
		const res = await fetch(`${c.baseUrl}/chat/completions`, {
			method: "POST",
			signal: AbortSignal.timeout(timeoutMs),
			headers: headers(c),
			body: JSON.stringify(body),
		});
		const json = (await res.json().catch(() => null)) as {
			choices?: {
				finish_reason?: string;
				message?: { content?: string | null };
			}[];
		} | null;
		return {
			status: res.status,
			error: res.ok
				? null
				: `OpenAI 互換 API ${res.status}: ${errorMessage(json, res)}`,
			choice: json?.choices?.[0],
		};
	};

	return {
		unavailable: () => (connection() ? null : NO_CONNECTION),
		async generate(model, prompt, schema: ResponseSchema) {
			const c = connection();
			if (!c) throw new Error(NO_CONNECTION);
			const jsonSchema = toJsonSchema(schema);
			const key = `${c.baseUrl} ${model}`;
			let r = schemaRejected.has(key)
				? null
				: await post(c, {
						model,
						messages: [{ role: "user", content: prompt }],
						// strict は使わない。任意の項目が多い形は「全項目必須」の制約に合わない。形のずれは呼び出し側の検証で弾く
						response_format: {
							type: "json_schema",
							json_schema: { name: "response", schema: jsonSchema },
						},
					});
			// 接続先によっては形の書き方や複雑さに制限があり、400 で断られる（Claude は任意の項目が 24 個まで等）。
			// 形を文章で渡して問い合わせ直し、受け取った後の検証に任せる
			const retried = r !== null && r.status === 400;
			if (r === null || retried) {
				r = await post(c, {
					model,
					messages: [
						{
							role: "user",
							content: `${prompt}\n\n# 出力の形\n次の JSON Schema に従う JSON だけを返す。使わない項目は null にする。\n${JSON.stringify(jsonSchema)}`,
						},
					],
				});
			}
			if (r.error) throw new Error(r.error);
			// 文章で渡して通ったときだけ覚える。モデル名の誤りなど形と関係ない 400 なら、ここまでで失敗している
			if (retried) schemaRejected.add(key);
			const text = r.choice?.message?.content ?? "";
			if (!text) {
				throw new Error(
					`OpenAI 互換 API の応答が空（${r.choice?.finish_reason ?? "理由不明"}）`,
				);
			}
			return parseJsonText(text);
		},
	};
}

/** 接続先の /models を読む。失敗したら理由を投げる */
export async function fetchCompatibleModels(
	c: CompatibleConnection,
): Promise<CompatibleModelOption[]> {
	const res = await fetch(`${c.baseUrl}/models`, {
		signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
		headers: headers(c),
	});
	const body = (await res.json().catch(() => null)) as {
		data?: { id?: unknown }[];
	} | null;
	if (!res.ok) {
		throw new Error(
			`OpenAI 互換 API ${res.status}: ${errorMessage(body, res)}`,
		);
	}
	if (!Array.isArray(body?.data)) {
		throw new Error("OpenAI 互換 API のモデル一覧の形が違う");
	}
	const ids = body.data
		.map((m) => m.id)
		.filter((id): id is string => typeof id === "string" && id !== "");
	return [...new Set(ids)]
		.sort((a, b) => a.localeCompare(b))
		.map((id) => ({ id: `${COMPATIBLE_PREFIX}${id}`, label: id }));
}

/** 選んだモデルの印を見て、Gemini 直結か OpenAI 互換かへ振り分ける */
export function routedModel(
	gemini: GeminiModel,
	compatible: GeminiModel,
): GeminiModel {
	const route = (id: string) =>
		isCompatibleModel(id)
			? { m: compatible, id: id.slice(COMPATIBLE_PREFIX.length) }
			: { m: gemini, id };
	return {
		unavailable(id) {
			const r = route(id);
			return r.m.unavailable(r.id);
		},
		generate(id, prompt, schema) {
			const r = route(id);
			return r.m.generate(r.id, prompt, schema);
		},
	};
}
