import { Hono } from "hono";
import { validator } from "hono/validator";
import type { AdviceService } from "../advice/types";

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null;

export function adviceRoutes(service: AdviceService) {
	return new Hono()
		.get("/runs/:id", (c) =>
			c.json({ advice: service.get(Number(c.req.param("id"))) }),
		)
		.post("/runs/:id", (c) => {
			const r = service.start(Number(c.req.param("id")));
			return r.ok
				? c.json({ advice: r.advice }, 202)
				: c.json({ message: r.message }, r.status);
		})
		.get("/runs/:id/external-prompt", (c) => {
			const r = service.externalPrompt(Number(c.req.param("id")));
			return r.ok
				? c.json(
						{ prompt: r.prompt, instructionsVersion: r.instructionsVersion },
						200,
					)
				: c.json({ message: r.message }, r.status);
		})
		.post(
			"/runs/:id/import",
			validator("json", (v, c) => {
				if (
					!isObj(v) ||
					typeof v.text !== "string" ||
					!Number.isSafeInteger(v.instructionsVersion)
				) {
					return c.json({ message: "text と instructionsVersion が必要" }, 400);
				}
				return {
					text: v.text,
					model: typeof v.model === "string" ? v.model : "",
					instructionsVersion: v.instructionsVersion as number,
				};
			}),
			(c) => {
				const r = service.importExternal(
					Number(c.req.param("id")),
					c.req.valid("json"),
				);
				return r.ok
					? c.json({ advice: r.advice }, 200)
					: c.json({ message: r.message }, r.status);
			},
		)
		.get("/instructions", (c) => c.json(service.instructions()))
		.post(
			"/instructions",
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
				const r = service.addInstructions(text, note);
				return r.ok
					? c.json({ version: r.version }, 201)
					: c.json({ message: r.message, field: "text" }, 400);
			},
		)
		.put(
			"/instructions/active",
			validator("json", (v, c) => {
				if (!isObj(v) || !Number.isSafeInteger(v.version)) {
					return c.json({ message: "version が必要" }, 400);
				}
				return { version: v.version as number };
			}),
			(c) =>
				service.setActiveInstructions(c.req.valid("json").version)
					? c.json(service.instructions(), 200)
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
		);
}
