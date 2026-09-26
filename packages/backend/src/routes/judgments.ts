import type { AggregationRule } from "@trading-studio/core";
import {
	isTimeframe,
	parseAggregationRule,
	TIMEFRAME_MS,
	validateAggregationRule,
} from "@trading-studio/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { validator } from "hono/validator";
import type { JudgmentService } from "../judgments/types";

/** 一度に返す足の上限。チャートの足の上限（5万本）に余裕を持たせる */
const MAX_SERIES = 100_000;

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
		.get(
			"/series",
			validator("query", (q, c) => {
				const from = Number(q.from);
				const to = Number(q.to);
				if (!isTimeframe(q.timeframe)) {
					return c.json({ message: "足の粒度を選ぶ" }, 400);
				}
				if (
					!Number.isSafeInteger(from) ||
					!Number.isSafeInteger(to) ||
					from > to
				) {
					return c.json({ message: "期間の形が違う" }, 400);
				}
				const step = TIMEFRAME_MS[q.timeframe];
				if ((to - from) / step > MAX_SERIES) {
					return c.json(
						{ message: `足が多すぎる（上限 ${MAX_SERIES}本）` },
						400,
					);
				}
				return { from, to, timeframe: q.timeframe };
			}),
			compress(),
			(c) => {
				const { from, to, timeframe } = c.req.valid("query");
				return c.json(service.series(from, to, TIMEFRAME_MS[timeframe]), 200);
			},
		)
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
