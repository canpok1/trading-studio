import { isTimeframe } from "@trading-studio/core";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { validator } from "hono/validator";
import type { ChartRangeId, MarketService } from "../market/types";

const RANGES: readonly ChartRangeId[] = ["1d", "1w", "1m", "all"];
const isRange = (v: unknown): v is ChartRangeId =>
	(RANGES as readonly unknown[]).includes(v);
/** EMA の計算に足す本数の上限 */
const MAX_HISTORY = 1_000;

export function marketRoutes(service: MarketService) {
	return new Hono()
		.get("/latest", (c) => c.json(service.latest()))
		.get(
			"/bars",
			validator("query", (q, c) => {
				if (!isTimeframe(q.timeframe)) {
					return c.json({ message: "足の粒度を選ぶ" }, 400);
				}
				if (!isRange(q.range)) {
					return c.json({ message: "期間を選ぶ" }, 400);
				}
				const history = Math.min(
					MAX_HISTORY,
					Math.max(0, Math.floor(Number(q.history ?? 0)) || 0),
				);
				return { timeframe: q.timeframe, range: q.range, history };
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
				return c.json({ bars: r.bars }, 200);
			},
		);
}
