import type { Context } from "hono";
import { Hono } from "hono";
import { validator } from "hono/validator";
import type {
	OrderFilter,
	TradingMode,
	TradingResult,
	TradingService,
} from "../trading/types";

/** 注文の一覧で一度に返す上限 */
const MAX_ORDERS = 1000;

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
				// クエリの型は検査後の値から決まるので、件数は文字列のまま渡す
				const out: OrderFilter & { limit?: string } = filter;
				if (typeof q.limit === "string") out.limit = q.limit;
				return out;
			}),
			(c) => {
				const { limit, ...filter } = c.req.valid("query");
				const n = Number(limit);
				return c.json({
					orders: service.orders(
						filter,
						Number.isSafeInteger(n) && n >= 1
							? Math.min(n, MAX_ORDERS)
							: MAX_ORDERS,
					),
				});
			},
		)
		.get("/orders/:mode/:id", (c) => {
			const mode = c.req.param("mode");
			const found = isMode(mode)
				? service.order(mode, c.req.param("id"))
				: null;
			// 画面が使うのは判断の記録のうちそのときの判定だけ。state は形が決まっていないので返さない
			return found
				? c.json(
						{
							order: found.order,
							judgments: found.decision?.judgments ?? null,
						},
						200,
					)
				: c.json({ message: "注文が見つからない" }, 404);
		});
}
