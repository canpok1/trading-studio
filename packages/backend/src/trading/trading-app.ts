import type { Context } from "hono";
import { Hono } from "hono";
import { validator } from "hono/validator";
import type {
	OrderFilter,
	TradingFailure,
	TradingResult,
	TradingService,
} from "./types-domain";

/** 注文の一覧で一度に返す上限 */
const MAX_ORDERS = 1000;

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null;

function failure(c: Context, e: TradingFailure) {
	switch (e.kind) {
		case "running":
		case "not_running":
		case "limit":
		case "locked":
			return c.json({ kind: e.kind, message: e.message }, 409);
		case "not_found":
			return c.json({ kind: e.kind, message: e.message }, 404);
		case "invalid_strategy":
			return c.json(
				{ kind: e.kind, message: e.message, errors: e.errors },
				400,
			);
		case "unsupported_mode":
		case "unsupported_instrument":
		case "invalid_cash":
			return c.json({ kind: e.kind, message: e.message }, 400);
	}
}

function respond(c: Context, r: TradingResult) {
	return r.ok ? c.json({ status: r.status }, 200) : failure(c, r.error);
}

/** 戦略の id */
const strategyId = (c: Context) => Number(c.req.param("id"));

export function tradingRoutes(service: TradingService) {
	return new Hono()
		.get("/strategies", (c) => c.json({ strategies: service.runs() }))
		.get("/summaries", (c) => c.json({ summaries: service.summaries() }))
		.post("/strategies/:id/start", (c) =>
			respond(c, service.start(strategyId(c))),
		)
		.post("/strategies/:id/stop", (c) =>
			respond(c, service.stop(strategyId(c))),
		)
		.post(
			"/strategies/:id/reset",
			validator("json", (v, c) => {
				const cash = isObj(v) ? v.initialCash : undefined;
				if (typeof cash !== "number") {
					return c.json({ message: "initialCash は円の整数" }, 400);
				}
				return { initialCash: cash };
			}),
			(c) =>
				respond(
					c,
					service.reset(strategyId(c), c.req.valid("json").initialCash),
				),
		)
		.get("/strategies/:id/watch", (c) => {
			// 銘柄は省ける。クエリの検査を足すとクライアントの型が変わるので直接読む
			const r = service.watch(strategyId(c), c.req.query("instrument"));
			return r
				? c.json(r, 200)
				: c.json({ message: "戦略か銘柄が見つからない" }, 404);
		})
		.get("/strategies/:id/performance", (c) => {
			const performance = service.performance(strategyId(c));
			return performance
				? c.json({ performance }, 200)
				: c.json({ message: "戦略が見つからない" }, 404);
		})
		.get(
			"/orders",
			validator("query", (q) => {
				const filter: OrderFilter = {};
				const strategy = Number(q.strategy);
				if (typeof q.strategy === "string" && Number.isSafeInteger(strategy)) {
					filter.strategyId = strategy;
				}
				if (
					q.status === "open" ||
					q.status === "filled" ||
					q.status === "canceled"
				) {
					filter.status = q.status;
				}
				if (q.side === "buy" || q.side === "sell") filter.side = q.side;
				if (typeof q.instrument === "string" && q.instrument !== "") {
					filter.instrument = q.instrument;
				}
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
					...service.orderSummary(filter),
				});
			},
		)
		.get("/orders/:strategy/:id", (c) => {
			const found = service.order(
				Number(c.req.param("strategy")),
				c.req.param("id"),
			);
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
