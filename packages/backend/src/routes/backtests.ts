import { parseConditionSet } from "@trading-studio/core";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { validator } from "hono/validator";
import type {
	BacktestInput,
	BacktestService,
	OrderFilter,
} from "../backtests/types";

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null;

const num = (v: unknown) => (typeof v === "number" ? v : Number.NaN);

const NOT_FOUND = { message: "バックテストの実行が見つからない" };

/** 注文一覧の1ページの上限 */
const MAX_LIMIT = 200;

export function backtestRoutes(service: BacktestService) {
	return (
		new Hono()
			.get("/", (c) => c.json({ runs: service.list() }))
			.post(
				"/",
				validator("json", (v, c) => {
					const params = parseConditionSet(isObj(v) ? v.params : null);
					if (!isObj(v) || !params || !isObj(v.fees)) {
						return c.json({ message: "実行条件の形が違う" }, 400);
					}
					const input: BacktestInput = {
						strategyId: typeof v.strategyId === "number" ? v.strategyId : null,
						params,
						from: num(v.from),
						to: num(v.to),
						initialCash: num(v.initialCash),
						fees: {
							limitPpm: num(v.fees.limitPpm),
							marketPpm: num(v.fees.marketPpm),
						},
						skipGaps: v.skipGaps === true,
					};
					return input;
				}),
				(c) => {
					const r = service.start(c.req.valid("json"));
					if (r.ok) return c.json({ run: r.run }, 202);
					const e = r.error;
					switch (e.kind) {
						case "busy":
							return c.json(
								{
									kind: e.kind,
									message:
										"別のバックテストを実行中。終わるか中止してから実行する",
									run: e.run,
								},
								409,
							);
						case "invalid_params":
							return c.json(
								{
									kind: e.kind,
									message: "条件に入力の誤りがある",
									errors: e.errors,
								},
								400,
							);
						case "invalid_input":
							return c.json(
								{ kind: e.kind, message: e.message, field: e.field },
								400,
							);
						case "no_data":
							return c.json({ kind: e.kind, message: e.message }, 400);
						case "no_judgments":
							return c.json(
								{
									kind: e.kind,
									message: e.message,
									firstScoredAt: e.firstScoredAt,
								},
								400,
							);
						case "gaps":
							return c.json(
								{
									kind: e.kind,
									message: "期間内にデータの欠損がある",
									gaps: e.gaps,
									gapCount: e.gapCount,
									missingBars: e.missingBars,
								},
								409,
							);
					}
				},
			)
			.get("/current", (c) => c.json({ run: service.current() }))
			.get("/:id", (c) => {
				const run = service.get(Number(c.req.param("id")));
				return run ? c.json({ run }, 200) : c.json(NOT_FOUND, 404);
			})
			.post("/:id/cancel", (c) => {
				const run = service.cancel(Number(c.req.param("id")));
				return run ? c.json({ run }, 200) : c.json(NOT_FOUND, 404);
			})
			// 1分足で数か月分だと数 MB になるため圧縮して返す
			.get("/:id/chart", compress(), (c) => {
				const chart = service.chart(Number(c.req.param("id")));
				return chart ? c.json(chart, 200) : c.json(NOT_FOUND, 404);
			})
			.get(
				"/:id/orders",
				validator("query", (q) => {
					const filter: OrderFilter = q.filter === "filled" ? "filled" : "all";
					const offset = Math.max(0, Number(q.offset ?? 0) || 0);
					const limit = Math.min(
						MAX_LIMIT,
						Math.max(1, Number(q.limit ?? 20) || 20),
					);
					return { filter, offset, limit };
				}),
				(c) => {
					const { filter, offset, limit } = c.req.valid("query");
					const r = service.orders(
						Number(c.req.param("id")),
						filter,
						offset,
						limit,
					);
					return r ? c.json(r, 200) : c.json(NOT_FOUND, 404);
				},
			)
			.get("/:id/orders/:orderId", (c) => {
				const order = service.order(
					Number(c.req.param("id")),
					c.req.param("orderId"),
				);
				return order
					? c.json({ order }, 200)
					: c.json({ message: "注文が見つからない" }, 404);
			})
			.post(
				"/:id/save",
				validator("json", (v, c) => {
					if (isObj(v) && v.overwrite === true)
						return { overwrite: true as const };
					if (isObj(v) && typeof v.name === "string") return { name: v.name };
					return c.json({ message: "overwrite か name が必要" }, 400);
				}),
				(c) => {
					const r = service.saveToStrategy(
						Number(c.req.param("id")),
						c.req.valid("json"),
					);
					if (r.ok) return c.json({ strategy: r.strategy }, 200);
					if (r.kind === "not_found") return c.json(NOT_FOUND, 404);
					if (r.kind === "no_strategy") {
						return c.json(
							{
								message:
									"元の戦略が無いため上書きできない。新しい戦略として保存する",
							},
							409,
						);
					}
					return c.json({ message: r.message }, r.status);
				},
			)
	);
}
