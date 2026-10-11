import { Hono } from "hono";
import { validator } from "hono/validator";
import type { CompatibleService } from "../ai/types";

export function aiRoutes(compatible: CompatibleService) {
	return new Hono()
		.get("/compatible", (c) => c.json(compatible.status()))
		.put(
			"/compatible",
			validator("json", (v, c) => {
				if (
					typeof v !== "object" ||
					v === null ||
					typeof v.baseUrl !== "string" ||
					(v.apiKey !== undefined && typeof v.apiKey !== "string")
				) {
					return c.json(
						{ message: "baseUrl（文字列）と任意の apiKey（文字列）が必要" },
						400,
					);
				}
				return {
					baseUrl: v.baseUrl as string,
					apiKey: v.apiKey as string | undefined,
				};
			}),
			(c) => {
				const r = compatible.save(c.req.valid("json"));
				return r.ok
					? c.json(compatible.status(), 200)
					: c.json({ message: r.message }, 400);
			},
		)
		.delete("/compatible", (c) => {
			compatible.clear();
			return c.json(compatible.status(), 200);
		})
		.get("/compatible/models", async (c) => c.json(await compatible.models()));
}
