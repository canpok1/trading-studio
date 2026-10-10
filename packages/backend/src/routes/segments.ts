import { isMarketRegime } from "@trading-studio/core";
import { Hono } from "hono";
import type { JudgmentService } from "../judgments/types";
import type { ListedSegment, SegmentService } from "../segments/types";

export function segmentRoutes(
	service: SegmentService,
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
		// 古いニュースを消した後も、残した相場データではそのニュースで市場評価を出せるので、記録の始まりは相場データごとに違う
		const segments: ListedSegment[] = service
			.list(regime ?? null)
			.map((d) => ({ ...d, firstScoredAt: judgments.firstScoredAt(d.from) }));
		return c.json({ segments }, 200);
	});
}
