import type { Context } from "hono";
import { Hono } from "hono";
import { validator } from "hono/validator";
import type {
	OrderFilter,
	TradingMode,
	TradingResult,
	TradingService,
} from "../trading/types";

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null;
const isMode = (v: unknown): v is TradingMode => v === "paper" || v === "live";

function respond(c: Context, r: TradingResult) {
	if (r.ok) return c.json({ status: r.status }, 200);
	const e = r.error;
	switch (e.kind) {
		case "running":
		case "not_running":
			return c.json({ kind: e.kind, message: e.message }, 409);
		case "invalid_strategy":
			return c.json(
				{ kind: e.kind, message: e.message, errors: e.errors },
				400,
			);
		case "no_strategy":
		case "unsupported_mode":
		case "invalid_cash":
			return c.json({ kind: e.kind, message: e.message }, 400);
	}
}

export function tradingRoutes(service: TradingService) {
	return new Hono()
		.get("/status", (c) => c.json({ status: service.status() }))
		.post(
			"/start",
			validator("json", (v, c) => {
				const mode = isObj(v) ? v.mode : undefined;
				if (!isMode(mode)) {
					return c.json({ message: "mode は paper か live" }, 400);
				}
				return { mode };
			}),
			(c) => respond(c, service.start(c.req.valid("json").mode)),
		)
		.post("/stop", (c) => respond(c, service.stop()))
		.post(
			"/reset",
			validator("json", (v, c) => {
				const cash = isObj(v) ? v.initialCash : undefined;
				if (typeof cash !== "number") {
					return c.json({ message: "initialCash は円の整数" }, 400);
				}
				return { initialCash: cash };
			}),
			(c) => respond(c, service.reset(c.req.valid("json").initialCash)),
		)
		.get(
			"/orders",
			validator("query", (q) => {
				const filter: OrderFilter = {};
				if (isMode(q.mode)) filter.mode = q.mode;
				if (
					q.status === "open" ||
					q.status === "filled" ||
					q.status === "canceled"
				) {
					filter.status = q.status;
				}
				if (q.side === "buy" || q.side === "sell") filter.side = q.side;
				return filter;
			}),
			(c) => c.json({ orders: service.orders(c.req.valid("query")) }),
		)
		.get("/orders/:mode/:id", (c) => {
			const mode = c.req.param("mode");
			const found = isMode(mode)
				? service.order(mode, c.req.param("id"))
				: null;
			return found
				? c.json(found, 200)
				: c.json({ message: "注文が見つからない" }, 404);
		});
}
