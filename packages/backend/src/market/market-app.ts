import { Hono } from "hono";
import { compress } from "hono/compress";
import { validator } from "hono/validator";
import { parseBarsQuery } from "./market-domain";
import type { MarketService } from "./types-domain";

export function marketRoutes(service: MarketService) {
	return new Hono()
		.get("/latest", (c) => c.json(service.latest()))
		.get(
			"/bars",
			validator("query", (q, c) => {
				const r = parseBarsQuery(q);
				if (!r.ok) return c.json({ message: r.message }, 400);
				return { timeframe: r.timeframe, range: r.range, history: r.history };
			}),
			compress(),
			(c) => {
				const { timeframe, range, history } = c.req.valid("query");
				const r = service.bars(timeframe, range, history);
				if (!r.ok) {
					return c.json(
						{
							message: `足が多すぎる（${r.count}本。上限 ${r.max}本）。期間を短くするか粗い粒度にする`,
						},
						400,
					);
				}
				return c.json({ instrument: r.instrument, bars: r.bars }, 200);
			},
		);
}
