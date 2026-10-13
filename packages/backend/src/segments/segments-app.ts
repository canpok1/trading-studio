import { Hono } from "hono";
import type { JudgmentService } from "../judgments/types-domain";
import { listSegments } from "./segments-domain";
import type { SegmentService } from "./types-domain";

export function segmentRoutes(
	service: SegmentService,
	judgments: Pick<JudgmentService, "firstScoredAt">,
) {
	return new Hono().get("/", (c) => {
		const r = listSegments(service, judgments, c.req.query("regime"));
		return r.ok
			? c.json({ segments: r.segments }, 200)
			: c.json({ message: r.message }, 400);
	});
}
