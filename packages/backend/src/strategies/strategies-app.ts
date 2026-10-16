import type { Context } from "hono";
import { Hono } from "hono";
import { validator } from "hono/validator";
import type {
	StrategyLock,
	TradingFailure,
	TradingService,
} from "../trading/types-domain";
import { parseCreateInput, parseParamsInput } from "./strategies-domain";
import type { StrategyResult, StrategyService } from "./types-domain";

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null;

function respond(c: Context, r: StrategyResult, okStatus: 200 | 201 = 200) {
	if (r.ok) return c.json({ strategy: r.strategy }, okStatus);
	switch (r.error.kind) {
		case "not_found":
			return c.json({ message: "戦略が見つからない" }, 404);
		case "invalid_name":
			return c.json({ message: r.error.message, field: "name" }, 400);
		case "duplicate_name":
			return c.json({ message: r.error.message, field: "name" }, 409);
		case "invalid_params":
			return c.json(
				{ message: "条件に入力の誤りがある", errors: r.error.errors },
				400,
			);
	}
}

const LOCK_REASONS: Record<StrategyLock, string> = {
	running: "先に自動取引を停止する",
	holding:
		"保有か未約定の注文がなくなるのを待つ。売れるのを待つか、口座をリセットする",
};

function removeFailure(c: Context, e: TradingFailure) {
	return e.kind === "not_found"
		? c.json({ message: "戦略が見つからない" }, 404)
		: c.json({ message: e.message }, 409);
}

export function strategyRoutes(
	service: StrategyService,
	/** 条件の変更を止める理由と、口座ごとの削除 */
	trading: Pick<TradingService, "strategyLock" | "remove">,
) {
	/** 動かしている戦略を止めているなら 409 */
	const locked = (c: Context, what: string, id: number) => {
		const lock = trading.strategyLock(id);
		if (lock === null) return null;
		return c.json({ message: `${what}には、${LOCK_REASONS[lock]}` }, 409);
	};
	return new Hono()
		.get("/", (c) => c.json({ strategies: service.list() }))
		.get("/:id", (c) => {
			const s = service.get(Number(c.req.param("id")));
			return s
				? c.json({ strategy: s }, 200)
				: c.json({ message: "戦略が見つからない" }, 404);
		})
		.post(
			"/",
			validator("json", (v, c) => {
				const r = parseCreateInput(v);
				if (!r.ok) return c.json({ message: r.message }, 400);
				return { name: r.input.name, from: r.input.from };
			}),
			(c) => respond(c, service.create(c.req.valid("json")), 201),
		)
		.put(
			"/:id/params",
			validator("json", (v, c) => {
				const params = parseParamsInput(v);
				if (!params) return c.json({ message: "条件の形が違う" }, 400);
				return { params };
			}),
			(c) => {
				const id = Number(c.req.param("id"));
				const no = locked(c, "戦略の条件を変える", id);
				if (no) return no;
				return respond(c, service.updateParams(id, c.req.valid("json").params));
			},
		)
		.put(
			"/:id/name",
			validator("json", (v, c) => {
				if (!isObj(v) || typeof v.name !== "string")
					return c.json({ message: "name が必要" }, 400);
				return { name: v.name };
			}),
			(c) =>
				respond(
					c,
					service.rename(Number(c.req.param("id")), c.req.valid("json").name),
				),
		)
		.delete("/:id", (c) => {
			const r = trading.remove(Number(c.req.param("id")));
			return r.ok
				? c.json({ ok: true as const }, 200)
				: removeFailure(c, r.error);
		});
}
