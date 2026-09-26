import type { Context } from "hono";
import { Hono } from "hono";
import { validator } from "hono/validator";
import type { NewsService, NewsSourceResult } from "../news/types";
import { NEWS_LANGUAGES } from "../news/types";

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null;

const MAX_LIST = 500;

function respond(c: Context, r: NewsSourceResult, okStatus: 200 | 201 = 200) {
	if (r.ok) return c.json({ source: r.source }, okStatus);
	switch (r.kind) {
		case "not_found":
			return c.json({ message: "取得元が見つからない" }, 404);
		case "invalid":
			return c.json({ message: r.message, field: r.field }, 400);
		case "duplicate_url":
			return c.json({ message: r.message, field: "url" }, 409);
	}
}

export function newsRoutes(service: NewsService) {
	return new Hono()
		.get("/", (c) => {
			const limit = Math.min(
				MAX_LIST,
				Math.max(1, Math.floor(Number(c.req.query("limit") ?? 100)) || 100),
			);
			return c.json({ news: service.listNews(limit) });
		})
		.get("/status", (c) => c.json(service.status()))
		.get("/sources", (c) => c.json({ sources: service.listSources() }))
		.post(
			"/sources",
			validator("json", (v, c) => {
				if (
					!isObj(v) ||
					typeof v.name !== "string" ||
					typeof v.url !== "string" ||
					!(NEWS_LANGUAGES as readonly unknown[]).includes(v.language)
				) {
					return c.json({ message: "name・url・language が必要" }, 400);
				}
				return {
					name: v.name,
					url: v.url,
					language: v.language as (typeof NEWS_LANGUAGES)[number],
				};
			}),
			(c) => respond(c, service.addSource(c.req.valid("json")), 201),
		)
		.patch(
			"/sources/:id",
			validator("json", (v, c) => {
				if (!isObj(v)) return c.json({ message: "形が違う" }, 400);
				const patch: { enabled?: boolean; name?: string } = {};
				if (v.enabled !== undefined) {
					if (typeof v.enabled !== "boolean")
						return c.json({ message: "enabled は true か false" }, 400);
					patch.enabled = v.enabled;
				}
				if (v.name !== undefined) {
					if (typeof v.name !== "string")
						return c.json({ message: "name は文字列" }, 400);
					patch.name = v.name;
				}
				return patch;
			}),
			(c) =>
				respond(
					c,
					service.updateSource(Number(c.req.param("id")), c.req.valid("json")),
				),
		)
		.delete("/sources/:id", (c) =>
			service.removeSource(Number(c.req.param("id")))
				? c.json({ ok: true as const }, 200)
				: c.json({ message: "取得元が見つからない" }, 404),
		)
		.get("/settings", (c) =>
			c.json({ intervalMinutes: service.intervalMinutes() }),
		)
		.put(
			"/settings",
			validator("json", (v, c) => {
				if (!isObj(v) || typeof v.intervalMinutes !== "number") {
					return c.json({ message: "intervalMinutes が必要" }, 400);
				}
				return { intervalMinutes: v.intervalMinutes };
			}),
			(c) => {
				const r = service.setIntervalMinutes(
					c.req.valid("json").intervalMinutes,
				);
				return r.ok
					? c.json({ intervalMinutes: service.intervalMinutes() }, 200)
					: c.json({ message: r.message, field: "intervalMinutes" }, 400);
			},
		);
}
