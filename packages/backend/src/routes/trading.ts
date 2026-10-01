import type { Context } from "hono";
import { Hono } from "hono";
import { validator } from "hono/validator";
import type {
	OrderFilter,
	TradingFailure,
	TradingMode,
	TradingResult,
	TradingService,
} from "../trading/types";

/** 注文の一覧で一度に返す上限 */
const MAX_ORDERS = 1000;

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null;
const isMode = (v: unknown): v is TradingMode => v === "paper" || v === "live";

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
		case "no_strategy":
		case "unsupported_mode":
		case "invalid_cash":
		case "invalid_name":
			return c.json({ kind: e.kind, message: e.message }, 400);
	}
}

function respond(c: Context, r: TradingResult) {
	return r.ok ? c.json({ status: r.status }, 200) : failure(c, r.error);
}

const runId = (c: Context) => Number(c.req.param("id"));

export function tradingRoutes(service: TradingService) {
	return new Hono()
		.get("/runs", (c) => c.json({ runs: service.runs() }))
		.post(
			"/runs",
			validator("json", (v, c) => {
				if (!isObj(v)) return c.json({ message: "形が違う" }, 400);
				const { name, mode, strategyId } = v;
				if (typeof name !== "string") {
					return c.json({ message: "name は文字列" }, 400);
				}
				if (!isMode(mode)) {
					return c.json({ message: "mode は paper か live" }, 400);
				}
				if (strategyId !== null && typeof strategyId !== "number") {
					return c.json({ message: "strategyId は戦略の id か null" }, 400);
				}
				return { name, mode, strategyId };
			}),
			(c) => {
				const r = service.create(c.req.valid("json"));
				return r.ok ? c.json({ status: r.status }, 201) : failure(c, r.error);
			},
		)
		.patch(
			"/runs/:id",
			validator("json", (v, c) => {
				if (!isObj(v)) return c.json({ message: "形が違う" }, 400);
				const out: { name?: string; strategyId?: number | null } = {};
				if (v.name !== undefined) {
					if (typeof v.name !== "string") {
						return c.json({ message: "name は文字列" }, 400);
					}
					out.name = v.name;
				}
				if (v.strategyId !== undefined) {
					if (v.strategyId !== null && typeof v.strategyId !== "number") {
						return c.json({ message: "strategyId は戦略の id か null" }, 400);
					}
					out.strategyId = v.strategyId;
				}
				return out;
			}),
			(c) => respond(c, service.update(runId(c), c.req.valid("json"))),
		)
		.delete("/runs/:id", (c) => {
			const r = service.remove(runId(c));
			return r.ok ? c.json({ ok: true as const }, 200) : failure(c, r.error);
		})
		.post("/runs/:id/start", (c) => respond(c, service.start(runId(c))))
		.post("/runs/:id/stop", (c) => respond(c, service.stop(runId(c))))
		.post(
			"/runs/:id/reset",
			validator("json", (v, c) => {
				const cash = isObj(v) ? v.initialCash : undefined;
				if (typeof cash !== "number") {
					return c.json({ message: "initialCash は円の整数" }, 400);
				}
				return { initialCash: cash };
			}),
			(c) =>
				respond(c, service.reset(runId(c), c.req.valid("json").initialCash)),
		)
		.get("/runs/:id/performance", (c) => {
			const performance = service.performance(runId(c));
			return performance
				? c.json({ performance }, 200)
				: c.json({ message: "運用が見つからない" }, 404);
		})
		.get(
			"/orders",
			validator("query", (q) => {
				const filter: OrderFilter = {};
				const run = Number(q.run);
				if (typeof q.run === "string" && Number.isSafeInteger(run)) {
					filter.runId = run;
				}
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
					...service.orderSummary(filter),
				});
			},
		)
		.get("/orders/:run/:id", (c) => {
			const found = service.order(
				Number(c.req.param("run")),
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
