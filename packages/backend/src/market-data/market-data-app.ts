import { Hono } from "hono";
import { validator } from "hono/validator";
import {
	candleCsv,
	parseExportQuery,
	parseImportForm,
} from "./market-data-domain";
import type { MarketDataService } from "./types-domain";

export function marketDataRoutes(service: MarketDataService) {
	return new Hono()
		.get("/coverage", (c) => c.json({ timeframes: service.coverage() }))
		.get("/latest", (c) => c.json({ latest: service.latestClose() }))
		.get(
			"/usable-timeframes",
			validator("query", (q, c) => {
				const from = Number(q.from);
				const to = Number(q.to);
				if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
					return c.json({ message: "期間の形が違う" }, 400);
				}
				return { from: q.from as string, to: q.to as string };
			}),
			(c) => {
				const q = c.req.valid("query");
				return c.json({
					timeframes: service.usableTimeframes(Number(q.from), Number(q.to)),
				});
			},
		)
		.get(
			"/export",
			validator("query", (q, c) => {
				const r = parseExportQuery(q);
				if (!r.ok) return c.json({ message: r.message }, 400);
				return { timeframe: r.timeframe, from: r.from, to: r.to };
			}),
			(c) => {
				const { timeframe, from, to } = c.req.valid("query");
				const r = service.exportCandles(timeframe, from, to);
				if (!r) return c.json({ message: "期間に足が無い" }, 404);
				const { fileName, chunks } = candleCsv(timeframe, r);
				const it = chunks[Symbol.iterator]();
				const encoder = new TextEncoder();
				const body = new ReadableStream<Uint8Array>({
					pull(controller) {
						const next = it.next();
						if (next.done) controller.close();
						else controller.enqueue(encoder.encode(next.value));
					},
				});
				return c.body(body, 200, {
					"content-type": "text/csv; charset=utf-8",
					"content-disposition": `attachment; filename="${fileName}"`,
				});
			},
		)
		.get("/imports", (c) => c.json({ imports: service.listImports() }))
		.post(
			"/imports",
			validator("form", (value, c) => {
				const r = parseImportForm(value);
				if (!r.ok) return c.json({ message: r.message }, 400);
				return { file: r.file, timeframe: r.timeframe };
			}),
			async (c) => {
				const { file, timeframe } = c.req.valid("form");
				const text = await file.text();
				const r = service.startImport({ text, timeframe, fileName: file.name });
				if (!r.ok) {
					return c.json(
						{
							message: "別の取り込みが進行中。終わるか中止してから取り込む",
							job: r.job,
						},
						409,
					);
				}
				return c.json({ job: r.job }, 202);
			},
		)
		.get("/imports/:id", (c) => {
			const job = service.getImport(Number(c.req.param("id")));
			return job
				? c.json({ job }, 200)
				: c.json({ message: "取り込みが見つからない" }, 404);
		})
		.post(
			"/imports/:id/resolve",
			validator("json", (v, c) => {
				const overwrite = (v as { overwrite?: unknown } | null)?.overwrite;
				if (typeof overwrite !== "boolean") {
					return c.json(
						{ message: "overwrite を true か false で指定する" },
						400,
					);
				}
				return { overwrite };
			}),
			(c) => {
				const r = service.resolveImport(
					Number(c.req.param("id")),
					c.req.valid("json").overwrite,
				);
				if (r.ok) return c.json({ job: r.job }, 200);
				return r.job
					? c.json(
							{ message: "この取り込みは確認を待っていない", job: r.job },
							409,
						)
					: c.json({ message: "取り込みが見つからない" }, 404);
			},
		)
		.post("/imports/:id/cancel", (c) => {
			const job = service.cancelImport(Number(c.req.param("id")));
			return job
				? c.json({ job }, 200)
				: c.json({ message: "取り込みが見つからない" }, 404);
		});
}
