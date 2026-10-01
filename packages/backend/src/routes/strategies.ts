import { isTemplateId, parseConditionSet } from "@trading-studio/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { validator } from "hono/validator";
import type {
	CreateStrategyInput,
	StrategyResult,
	StrategyService,
} from "../strategies/types";
import type { StrategyLock } from "../trading/types";

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
	holding: "保有か未約定の注文がある。売れるのを待つか、口座をリセットする",
};

export function strategyRoutes(
	service: StrategyService,
	/** 運用する戦略を変えさせない理由。自動取引がオンの間と、保有か未約定の注文がある間 */
	strategyLock: () => StrategyLock | null = () => null,
) {
	/** 運用する戦略（id を渡せばそれが運用する戦略のときだけ）を止めているなら 409 */
	const locked = (c: Context, what: string, id?: number) => {
		const lock = strategyLock();
		if (lock === null) return null;
		if (id !== undefined && service.active()?.id !== id) return null;
		return c.json({ message: `${what}には、${LOCK_REASONS[lock]}` }, 409);
	};
	return (
		new Hono()
			.get("/", (c) => c.json({ strategies: service.list() }))
			// "/:id" より前に置く
			.get("/active", (c) => c.json({ strategy: service.active() }))
			.put(
				"/active",
				validator("json", (v, c) => {
					const id = isObj(v) ? v.id : undefined;
					if (id !== null && !Number.isSafeInteger(id)) {
						return c.json({ message: "id は戦略の ID か null" }, 400);
					}
					return { id: id as number | null };
				}),
				(c) => {
					const no = locked(c, "運用する戦略を変える");
					if (no) return no;
					return service.setActive(c.req.valid("json").id)
						? c.json({ strategy: service.active() }, 200)
						: c.json({ message: "戦略が見つからない" }, 404);
				},
			)
			.get("/:id", (c) => {
				const s = service.get(Number(c.req.param("id")));
				return s
					? c.json({ strategy: s }, 200)
					: c.json({ message: "戦略が見つからない" }, 404);
			})
			.post(
				"/",
				validator("json", (v, c) => {
					if (!isObj(v) || typeof v.name !== "string" || !isObj(v.from)) {
						return c.json({ message: "name と from が必要" }, 400);
					}
					const f = v.from;
					let from: CreateStrategyInput["from"] | null = null;
					if (isTemplateId(f.template)) from = { template: f.template };
					else if (typeof f.copyOf === "number") from = { copyOf: f.copyOf };
					else {
						const params = parseConditionSet(f.params);
						if (params) from = { params };
					}
					if (!from) return c.json({ message: "from の形が違う" }, 400);
					return { name: v.name, from };
				}),
				(c) => respond(c, service.create(c.req.valid("json")), 201),
			)
			.put(
				"/:id/params",
				validator("json", (v, c) => {
					const params = parseConditionSet(isObj(v) ? v.params : null);
					if (!params) return c.json({ message: "条件の形が違う" }, 400);
					return { params };
				}),
				(c) => {
					const id = Number(c.req.param("id"));
					const no = locked(c, "運用する戦略の条件を変える", id);
					if (no) return no;
					return respond(
						c,
						service.updateParams(id, c.req.valid("json").params),
					);
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
				const id = Number(c.req.param("id"));
				const no = locked(c, "運用する戦略を削除する", id);
				if (no) return no;
				return service.remove(id)
					? c.json({ ok: true as const }, 200)
					: c.json({ message: "戦略が見つからない" }, 404);
			})
	);
}
