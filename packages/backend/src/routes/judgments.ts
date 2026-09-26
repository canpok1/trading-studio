import type { AggregationRule } from "@trading-studio/core";
import {
	parseAggregationRule,
	validateAggregationRule,
} from "@trading-studio/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { validator } from "hono/validator";
import type { JudgmentService } from "../judgments/types";

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null;

function ruleOf(v: unknown, c: Context) {
	const rule = parseAggregationRule(isObj(v) ? v.rule : null);
	if (!rule) return c.json({ message: "集計ルールの形が違う" }, 400);
	return { rule };
}

export function judgmentRoutes(service: JudgmentService) {
	return new Hono()
		.get("/current", (c) => c.json(service.current()))
		.post("/preview", validator("json", ruleOf), (c) => {
			const rule: AggregationRule = c.req.valid("json").rule;
			const errors = validateAggregationRule(rule);
			return errors.length
				? c.json({ message: "集計ルールに入力の誤りがある", errors }, 400)
				: c.json(service.current(rule), 200);
		})
		.get("/rule", (c) => c.json({ rule: service.rule() }))
		.put("/rule", validator("json", ruleOf), (c) => {
			const r = service.saveRule(c.req.valid("json").rule);
			return r.ok
				? c.json({ rule: service.rule() }, 200)
				: c.json(
						{ message: "集計ルールに入力の誤りがある", errors: r.errors },
						400,
					);
		});
}
