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
		.get("/api-key", (c) => c.json(service.apiKey()))
		.put(
			"/api-key",
			validator("json", (v, c) => {
				if (!isObj(v) || typeof v.key !== "string") {
					return c.json({ message: "key が必要" }, 400);
				}
				return { key: v.key };
			}),
			(c) => {
				const r = service.setApiKey(c.req.valid("json").key);
				return r.ok
					? c.json(service.apiKey(), 200)
					: c.json({ message: r.message }, 400);
			},
		)
		.delete("/api-key", (c) => {
			service.deleteApiKey();
			return c.json(service.apiKey(), 200);
		})
		.post("/news/:id/retry", (c) =>
			service.retry(Number(c.req.param("id")))
				? c.json({ ok: true as const }, 200)
				: c.json({ message: "採点に失敗したニュースではない" }, 409),
		)
		.get(
			"/rescore",
			validator("query", (q) => ({
				from: Number(q.from),
				to: Number(q.to),
				version: Number(q.version),
			})),
			(c) => {
				const { from, to, version } = c.req.valid("query");
				const r = service.rescoreCoverage(from, to, version);
				return r.ok
					? c.json({ coverage: r.coverage }, 200)
					: c.json({ message: r.message }, r.status);
			},
		)
		.post(
			"/rescore",
			validator("json", (v, c) => {
				if (!isObj(v)) return c.json({ message: "形が違う" }, 400);
				return {
					from: Number(v.from),
					to: Number(v.to),
					version: Number(v.version),
				};
			}),
			(c) => {
				const { from, to, version } = c.req.valid("json");
				const r = service.requestRescore(from, to, version);
				return r.ok
					? c.json({ coverage: r.coverage }, 200)
					: c.json({ message: r.message }, r.status);
			},
		)
		.post(
			"/trial",
			validator("json", (v, c) => {
				if (!isObj(v) || typeof v.criteria !== "string") {
					return c.json({ message: "criteria が必要" }, 400);
				}
				if (
					v.newsIds !== undefined &&
					!(
						Array.isArray(v.newsIds) &&
						v.newsIds.every((x) => Number.isSafeInteger(x))
					)
				) {
					return c.json({ message: "newsIds は整数の配列にする" }, 400);
				}
				return {
					criteria: v.criteria,
					newsIds: v.newsIds as number[] | undefined,
				};
			}),
			async (c) => {
				const { criteria, newsIds } = c.req.valid("json");
				const r = await service.trial(criteria, newsIds);
				return r.ok ? c.json(r, 200) : c.json({ message: r.message }, 400);
			},
		);
}
