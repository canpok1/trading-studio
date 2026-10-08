import { isMarketRegime } from "@trading-studio/core";
import { Hono } from "hono";
import type { DatasetService, ListedDataset } from "../datasets/types";
import type { JudgmentService } from "../judgments/types";

export function datasetRoutes(
	service: DatasetService,
	judgments: Pick<JudgmentService, "firstScoredAt">,
) {
	return new Hono().get("/", (c) => {
		const regime = c.req.query("regime");
		if (regime !== undefined && !isMarketRegime(regime)) {
			return c.json(
				{ message: "相場は up・down・range・volatile のどれか" },
				400,
			);
		}
		// 古いニュースを消した後も、残したデータセットではそのニュースで市場評価を出せるので、記録の始まりはデータセットごとに違う
		const datasets: ListedDataset[] = service
			.list(regime ?? null)
			.map((d) => ({ ...d, firstScoredAt: judgments.firstScoredAt(d.from) }));
		return c.json({ datasets }, 200);
	});
}
