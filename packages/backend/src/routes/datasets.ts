import { isMarketRegime } from "@trading-studio/core";
import { Hono } from "hono";
import type { DatasetService } from "../datasets/types";

export function datasetRoutes(service: DatasetService) {
	return new Hono().get("/", (c) => {
		const regime = c.req.query("regime");
		if (regime !== undefined && !isMarketRegime(regime)) {
			return c.json(
				{ message: "相場は up・down・range・volatile のどれか" },
				400,
			);
		}
		return c.json({ datasets: service.list(regime ?? null) }, 200);
	});
}
