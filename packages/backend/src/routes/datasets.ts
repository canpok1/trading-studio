import { parseConditionSet } from "@trading-studio/core";
import { Hono } from "hono";
import { validator } from "hono/validator";
import type {
	DatasetInput,
	DatasetRunInput,
	DatasetService,
} from "../datasets/types";

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null;
const num = (v: unknown) => (typeof v === "number" ? v : Number.NaN);

const NOT_FOUND = { message: "データセットが見つからない" };
const RUN_NOT_FOUND = { message: "まとめた実行が見つからない" };

const datasetInput = validator("json", (v, c) => {
	if (
		!isObj(v) ||
		typeof v.name !== "string" ||
		!Array.isArray(v.segmentIds) ||
		!v.segmentIds.every((x) => Number.isSafeInteger(x))
	) {
		return c.json({ message: "name と segmentIds（整数の配列）が必要" }, 400);
	}
	const input: DatasetInput = {
		name: v.name,
		segmentIds: v.segmentIds as number[],
	};
	return input;
});

/** データセット（相場データを束ねたもの）の保存 */
export function datasetRoutes(service: DatasetService) {
	return new Hono()
		.get("/", (c) => c.json({ datasets: service.list() }, 200))
		.post("/", datasetInput, (c) => {
			const r = service.create(c.req.valid("json"));
			if (r.ok) return c.json({ dataset: r.dataset }, 201);
			return c.json(
				{ message: r.message },
				r.kind === "duplicate_name" ? 409 : 400,
			);
		})
		.put("/:id", datasetInput, (c) => {
			const r = service.update(Number(c.req.param("id")), c.req.valid("json"));
			if (r.ok) return c.json({ dataset: r.dataset }, 200);
			return c.json(
				{ message: r.message },
				r.kind === "not_found" ? 404 : r.kind === "duplicate_name" ? 409 : 400,
			);
		})
		.delete("/:id", (c) =>
			service.remove(Number(c.req.param("id")))
				? c.json({ ok: true as const }, 200)
				: c.json(NOT_FOUND, 404),
		);
}

/** データセットのまとめた実行 */
export function datasetRunRoutes(service: DatasetService) {
	return new Hono()
		.post(
			"/",
			validator("json", (v, c) => {
				const params = parseConditionSet(isObj(v) ? v.params : null);
				if (!isObj(v) || !params || !isObj(v.fees)) {
					return c.json({ message: "実行条件の形が違う" }, 400);
				}
				const input: DatasetRunInput = {
					datasetId: num(v.datasetId),
					name: typeof v.name === "string" ? v.name : "",
					params,
					initialCash: num(v.initialCash),
					fees: {
						limitPpm: num(v.fees.limitPpm),
						marketPpm: num(v.fees.marketPpm),
					},
					skipGaps: v.skipGaps === true,
					criteriaVersion:
						v.criteriaVersion === undefined || v.criteriaVersion === null
							? null
							: num(v.criteriaVersion),
				};
				return input;
			}),
			(c) => {
				const r = service.start(c.req.valid("json"));
				if (r.ok) return c.json({ run: r.run }, 202);
				const e = r.error;
				switch (e.kind) {
					case "busy":
						return c.json({ kind: e.kind, message: e.message }, 409);
					case "not_found":
						return c.json({ kind: e.kind, message: e.message }, 404);
					case "empty":
						return c.json({ kind: e.kind, message: e.message }, 400);
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
					case "blocked":
						return c.json(
							{
								kind: e.kind,
								message: "実行できない相場データがある",
								blockers: e.blockers,
							},
							409,
						);
				}
			},
		)
		.get("/current", (c) => c.json({ run: service.current() }))
		.get("/:id", (c) => {
			const run = service.run(Number(c.req.param("id")));
			return run ? c.json({ run }, 200) : c.json(RUN_NOT_FOUND, 404);
		})
		.post("/:id/cancel", (c) => {
			const run = service.cancel(Number(c.req.param("id")));
			return run ? c.json({ run }, 200) : c.json(RUN_NOT_FOUND, 404);
		});
}
