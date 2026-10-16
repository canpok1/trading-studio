import type { Context } from "hono";
import { Hono } from "hono";
import { validator } from "hono/validator";
import { parseEventSourceInput } from "./calendar-domain";
import type {
	CalendarService,
	EventSourceInput,
	EventSourceResult,
} from "./types-domain";

function respond(c: Context, r: EventSourceResult, okStatus: 200 | 201 = 200) {
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

const sourceInput = validator("json", (v, c) => {
	const input = parseEventSourceInput(v);
	if (!input) return c.json({ message: "name・url・keywords が必要" }, 400);
	return input as EventSourceInput;
});

export function calendarRoutes(service: CalendarService) {
	return new Hono()
		.get("/status", (c) => c.json(service.status()))
		.get("/sources", (c) => c.json({ sources: service.listSources() }))
		.post("/sources", sourceInput, (c) =>
			respond(c, service.addSource(c.req.valid("json")), 201),
		)
		.put("/sources/:id", sourceInput, (c) =>
			respond(
				c,
				service.updateSource(Number(c.req.param("id")), c.req.valid("json")),
			),
		)
		.delete("/sources/:id", (c) =>
			service.removeSource(Number(c.req.param("id")))
				? c.json({ ok: true as const }, 200)
				: c.json({ message: "取得元が見つからない" }, 404),
		);
}
