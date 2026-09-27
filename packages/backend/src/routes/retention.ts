import { Hono } from "hono";
import { validator } from "hono/validator";
import type { RetentionService } from "../retention/types";

const isDays = (v: unknown): v is number | null =>
	v === null || typeof v === "number";

export function retentionRoutes(service: RetentionService) {
	return new Hono()
		.get("/", (c) => c.json(service.status()))
		.put(
			"/",
			validator("json", (v, c) => {
				if (
					typeof v !== "object" ||
					v === null ||
					!isDays(v.decisionsDays) ||
					!isDays(v.backtestsDays)
				) {
					return c.json(
						{ message: "decisionsDays と backtestsDays（日数か null）が必要" },
						400,
					);
				}
				return {
					decisionsDays: v.decisionsDays as number | null,
					backtestsDays: v.backtestsDays as number | null,
				};
			}),
			(c) => {
				const r = service.setSettings(c.req.valid("json"));
				return r.ok
					? c.json(service.status(), 200)
					: c.json({ message: r.message, field: r.field }, 400);
			},
		);
}
