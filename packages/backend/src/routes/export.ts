import { Hono } from "hono";
import { validator } from "hono/validator";
import type { AnalysisExportService } from "../analysis-export/types";

/** 期間 [from, to) の形を確かめる */
function period(q: Record<string, string | string[]>) {
	const from = Number(q.from);
	const to = Number(q.to);
	if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to) {
		return null;
	}
	return { from, to };
}

export function exportRoutes(service: AnalysisExportService) {
	return new Hono()
		.get(
			"/backtests",
			validator("query", (q, c) => {
				const p = period(q);
				if (!p) return c.json({ message: "期間の形が違う" }, 400);
				return { from: q.from as string, to: q.to as string };
			}),
			(c) => {
				const q = c.req.valid("query");
				return c.json({
					runs: service.backtestRuns(Number(q.from), Number(q.to)),
				});
			},
		)
		.get(
			"/analysis",
			validator("query", (q, c) => {
				const p = period(q);
				if (!p) return c.json({ message: "期間の形が違う" }, 400);
				const raw = typeof q.backtests === "string" ? q.backtests : "";
				const ids = raw === "" ? [] : raw.split(",").map(Number);
				if (!ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
					return c.json({ message: "バックテストの指定の形が違う" }, 400);
				}
				return {
					from: q.from as string,
					to: q.to as string,
					backtests: raw,
				};
			}),
			(c) => {
				const q = c.req.valid("query");
				const r = service.build({
					from: Number(q.from),
					to: Number(q.to),
					backtestIds:
						q.backtests === ""
							? []
							: [...new Set(q.backtests.split(",").map(Number))],
				});
				if (!r.ok) return c.json({ message: r.message }, 404);
				return c.body(r.data as Uint8Array<ArrayBuffer>, 200, {
					"content-type": "application/zip",
					"content-disposition": `attachment; filename="${r.fileName}"`,
				});
			},
		);
}
