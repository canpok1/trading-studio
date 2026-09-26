import { isTimeframe } from "@trading-studio/core";
import { Hono } from "hono";
import { validator } from "hono/validator";
import type { MarketDataService } from "../market-data/types";

export function marketDataRoutes(service: MarketDataService) {
	return new Hono()
		.get("/coverage", (c) => c.json({ timeframes: service.coverage() }))
		.get("/latest", (c) => c.json({ latest: service.latestClose() }))
		.get("/imports", (c) => c.json({ imports: service.listImports() }))
		.post(
			"/imports",
			validator("form", (value, c) => {
				const file = value.file;
				const timeframe = value.timeframe;
				if (!(file instanceof File)) {
					return c.json({ message: "CSV ファイルを選ぶ" }, 400);
				}
				if (!isTimeframe(timeframe)) {
					return c.json({ message: "足の粒度を選ぶ" }, 400);
				}
				return { file, timeframe };
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
