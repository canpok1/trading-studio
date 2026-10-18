import { Hono } from "hono";
import { compress } from "hono/compress";
import { validator } from "hono/validator";
import { parseDvolBarsQuery } from "./dvol-domain";
import type { DvolService } from "./types-domain";

export function dvolRoutes(service: DvolService) {
	return new Hono()
		.get("/status", (c) => c.json(service.status()))
		.get(
			"/bars",
			validator("query", (q, c) => {
				const r = parseDvolBarsQuery(q as Record<string, string | undefined>);
				if (!r) {
					return c.json(
						{
							message:
								"期間を整数で、足の粒度を正しい値で、平均の日数を 1〜30 の整数で指定する",
						},
						400,
					);
				}
				return r;
			}),
			compress(),
			(c) => {
				const { from, to, timeframe, averageDays } = c.req.valid("query");
				const r = service.bars(from, to, timeframe, averageDays);
				if (!r.ok) {
					return c.json(
						{
							message: `足が多すぎる（${r.count}本。上限 ${r.max}本）。期間を短くする`,
						},
						400,
					);
				}
				return c.json({ bars: r.bars }, 200);
			},
		);
}
