import { Hono } from "hono";
import { compress } from "hono/compress";
import { validator } from "hono/validator";
import { parseBarsQuery } from "./market-domain";
import type { MarketService } from "./types-domain";

/**
 * byInstrument は収集している銘柄ごとの価格と足。instrument（クエリ）で銘柄を選び、省くと既定の銘柄（service）を使う。
 * クエリの検査を足すとクライアントの型が変わるので、銘柄は直接読む
 */
export function marketRoutes(
	service: MarketService,
	byInstrument: readonly MarketService[],
) {
	const pick = (id: string | undefined) =>
		id === undefined
			? service
			: (byInstrument.find((s) => s.instrument.id === id) ?? null);
	const unknown = { message: "収集していない銘柄" };
	return new Hono()
		.get("/latest", (c) => {
			const s = pick(c.req.query("instrument"));
			return s ? c.json(s.latest(), 200) : c.json(unknown, 400);
		})
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
				const s = pick(c.req.query("instrument"));
				if (!s) return c.json(unknown, 400);
				const r = s.bars(timeframe, range, history);
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
