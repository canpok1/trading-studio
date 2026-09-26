import { Hono } from "hono";
import { validator } from "hono/validator";
import type { ScoringService } from "../news/types";

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null;

export function scoringRoutes(service: ScoringService) {
	return new Hono()
		.get("/status", (c) => c.json(service.status()))
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
		.get("/model", (c) => c.json(service.models()))
		.put(
			"/model",
			validator("json", (v, c) => {
				if (!isObj(v) || typeof v.model !== "string") {
					return c.json({ message: "model が必要" }, 400);
				}
				return { model: v.model };
			}),
			(c) =>
				service.setModel(c.req.valid("json").model)
					? c.json(service.models(), 200)
					: c.json({ message: "選べないモデル" }, 400),
		)
		.post("/news/:id/retry", (c) =>
			service.retry(Number(c.req.param("id")))
				? c.json({ ok: true as const }, 200)
				: c.json({ message: "採点に失敗したニュースではない" }, 409),
		)
		.post(
			"/trial",
			validator("json", (v, c) => {
				if (!isObj(v) || typeof v.criteria !== "string") {
					return c.json({ message: "criteria が必要" }, 400);
				}
				return { criteria: v.criteria };
			}),
			async (c) => {
				const r = await service.trial(c.req.valid("json").criteria);
				return r.ok ? c.json(r, 200) : c.json({ message: r.message }, 400);
			},
		);
}
