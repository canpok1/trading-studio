import type { Context } from "hono";
import { Hono } from "hono";
import { validator } from "hono/validator";
import { parseEventListQuery, parseEventSourceInput } from "./calendar-domain";
import type {
	CalendarService,
	EventSourceInput,
	EventSourceResult,
} from "./types-domain";

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

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
	if (!input) return c.json({ message: "name・url が必要" }, 400);
	return input as EventSourceInput;
});

/** 期間と版。数でなければ 400 */
const period = (v: unknown) => {
	const o = isObj(v) ? v : {};
	const r = {
		from: Number(o.from),
		to: Number(o.to),
		version: Number(o.version),
	};
	return Object.values(r).every(Number.isSafeInteger) ? r : null;
};

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
		)
		.get("/criteria", (c) => c.json(service.criteria()))
		.post(
			"/criteria",
			validator("json", (v, c) => {
				if (!isObj(v) || typeof v.text !== "string") {
					return c.json({ message: "text が必要" }, 400);
				}
				return {
					text: v.text,
					note: typeof v.note === "string" ? v.note : "",
				};
			}),
			(c) => {
				const { text, note } = c.req.valid("json");
				const r = service.addCriteria(text, note);
				return r.ok
					? c.json({ version: r.version }, 201)
					: c.json({ message: r.message, field: "text" }, 400);
			},
		)
		.put(
			"/criteria/active",
			validator("json", (v, c) => {
				if (!isObj(v) || !Number.isSafeInteger(v.version)) {
					return c.json({ message: "version が必要" }, 400);
				}
				return { version: v.version as number };
			}),
			(c) =>
				service.setActiveCriteria(c.req.valid("json").version)
					? c.json(service.criteria(), 200)
					: c.json({ message: "版が見つからない" }, 404),
		)
		.get(
			"/judgments",
			validator("query", (q, c) => {
				const p = period(q);
				return p ?? c.json({ message: "from・to・version は整数" }, 400);
			}),
			(c) => {
				const { from, to, version } = c.req.valid("query");
				const coverage = service.judgmentCoverage(from, to, version);
				return coverage
					? c.json({ coverage }, 200)
					: c.json({ message: "版が見つからない" }, 404);
			},
		)
		.get(
			"/events",
			validator("query", (q, c) => {
				const p = parseEventListQuery(q as Record<string, string | undefined>);
				return (
					p ??
					c.json(
						{
							message:
								"from・to・version は整数、minImportance は high・medium・low",
						},
						400,
					)
				);
			}),
			(c) => {
				const r = service.listEvents(c.req.valid("query"));
				return r
					? c.json(r, 200)
					: c.json({ message: "版が見つからない" }, 404);
			},
		)
		.post(
			"/events/:id/judge",
			validator("json", (v, c) => {
				const o = isObj(v) ? v : {};
				if (o.version !== undefined && !Number.isSafeInteger(o.version)) {
					return c.json({ message: "version は整数" }, 400);
				}
				return { version: o.version as number | undefined };
			}),
			(c) =>
				service.rejudgeEvent(
					Number(c.req.param("id")),
					c.req.valid("json").version,
				)
					? c.json({ ok: true as const }, 200)
					: c.json({ message: "判断に失敗した予定が見つからない" }, 404),
		)
		.post(
			"/judgments",
			validator("json", (v, c) => {
				const p = period(v);
				return p ?? c.json({ message: "from・to・version は整数" }, 400);
			}),
			(c) => {
				const { from, to, version } = c.req.valid("json");
				const coverage = service.requestJudgments(from, to, version);
				return coverage
					? c.json({ coverage }, 200)
					: c.json({ message: "版が見つからない" }, 404);
			},
		);
}
