import type { Context } from "hono";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { validator } from "hono/validator";
import { parseRuleInput, parseSeriesQuery } from "./judgments-domain";
import type { JudgmentService } from "./types-domain";

function ruleOf(v: unknown, c: Context) {
	const rule = parseRuleInput(v);
	if (!rule) return c.json({ message: "評価ルールの形が違う" }, 400);
	return { rule };
}

export function judgmentRoutes(service: JudgmentService) {
	return new Hono()
		.get("/current", (c) => {
			const at = c.req.query("at");
			if (at === undefined || at === "") return c.json(service.current(), 200);
			const t = Number(at);
			return Number.isSafeInteger(t)
				? c.json(service.current(undefined, t), 200)
				: c.json({ message: "時刻の形が違う" }, 400);
		})
		.get(
			"/series",
			validator("query", (q, c) => {
				const r = parseSeriesQuery(q);
				if (!r.ok) return c.json({ message: r.message }, 400);
				return { from: r.from, to: r.to, timeframe: r.timeframe };
			}),
			compress(),
			(c) => {
				const { from, to, timeframe } = c.req.valid("query");
				return c.json(service.seriesOf(from, to, timeframe), 200);
			},
		)
		.post("/preview", validator("json", ruleOf), (c) => {
			const r = service.preview(c.req.valid("json").rule);
			return r.ok
				? c.json(r.judgment, 200)
				: c.json(
						{ message: "評価ルールに入力の誤りがある", errors: r.errors },
						400,
					);
		})
		.get("/rule", (c) => c.json({ rule: service.rule() }))
		.put("/rule", validator("json", ruleOf), (c) => {
			const r = service.saveRule(c.req.valid("json").rule);
			return r.ok
				? c.json({ rule: service.rule() }, 200)
				: c.json(
						{ message: "評価ルールに入力の誤りがある", errors: r.errors },
						400,
					);
		});
}
