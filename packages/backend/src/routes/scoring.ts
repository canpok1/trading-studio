import { Hono } from "hono";
import { validator } from "hono/validator";
import type { ScoringService } from "../news/types";
import type {
	AccuracyHorizon,
	AccuracyPeriod,
	AccuracyService,
} from "../scoring-analysis/types";
import { ACCURACY_IDS_MAX } from "../scoring-analysis/types";

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null;

export function scoringRoutes(
	service: ScoringService,
	accuracy: AccuracyService,
) {
	return (
		new Hono()
			.get("/status", (c) => c.json(service.status()))
			.get(
				"/accuracy",
				validator("query", (v, c) => {
					const ids = (typeof v.ids === "string" ? v.ids : "")
						.split(",")
						.filter((x) => x !== "")
						.map(Number);
					if (
						ids.length > ACCURACY_IDS_MAX ||
						!ids.every((x) => Number.isSafeInteger(x))
					) {
						return c.json(
							{ message: `ids は ${ACCURACY_IDS_MAX} 件までの記事の ID` },
							400,
						);
					}
					return { ids };
				}),
				(c) => c.json(accuracy.articleAccuracy(c.req.valid("query").ids)),
			)
			.get(
				"/accuracy/summary",
				validator("query", (v, c) => {
					const int = (x: unknown) => {
						if (x === undefined || x === "") return undefined;
						const n = Number(x);
						return typeof x === "string" && Number.isSafeInteger(n) ? n : null;
					};
					const at = int(v.at);
					if (at === null) {
						return c.json({ message: "at はエポックミリ秒の整数" }, 400);
					}
					const criteriaVersion = int(v.criteriaVersion);
					if (criteriaVersion === null) {
						return c.json({ message: "criteriaVersion は版の番号" }, 400);
					}
					const appBuiltAt =
						v.appBuiltAt === "none" ? ("none" as const) : int(v.appBuiltAt);
					if (appBuiltAt === null) {
						return c.json(
							{ message: "appBuiltAt はエポックミリ秒の整数か none" },
							400,
						);
					}
					return { at, filter: { criteriaVersion, appBuiltAt } };
				}),
				(c) => {
					const q = c.req.valid("query");
					return c.json(accuracy.accuracySummary(q.at, q.filter));
				},
			)
			.get("/accuracy/settings", (c) => c.json(accuracy.accuracySettings()))
			.put(
				"/accuracy/settings",
				validator("json", (v, c) => {
					if (
						!isObj(v) ||
						typeof v.horizon !== "string" ||
						!isObj(v.sentimentBands) ||
						!isObj(v.riskBands) ||
						!(v.periodDays === null || typeof v.periodDays === "number")
					) {
						return c.json(
							{
								message:
									"horizon・sentimentBands・riskBands・periodDays が必要",
							},
							400,
						);
					}
					// 数でない境目は NaN にして、サービスの検査で弾く
					const num = (o: unknown, h: AccuracyHorizon, k: string) => {
						const b = isObj(o) ? o[h] : undefined;
						return isObj(b) && typeof b[k] === "number"
							? (b[k] as number)
							: Number.NaN;
					};
					const { sentimentBands: sb, riskBands: rb } = v;
					const both = <T>(f: (h: AccuracyHorizon) => T) => ({
						"4h": f("4h"),
						"24h": f("24h"),
					});
					return {
						horizon: v.horizon as AccuracyHorizon,
						periodDays: v.periodDays as AccuracyPeriod,
						sentimentBands: both((h) => ({
							small: num(sb, h, "small"),
							large: num(sb, h, "large"),
						})),
						riskBands: both((h) => ({
							slight: num(rb, h, "slight"),
							rough: num(rb, h, "rough"),
							heavy: num(rb, h, "heavy"),
							wild: num(rb, h, "wild"),
						})),
					};
				}),
				(c) => {
					const r = accuracy.setAccuracySettings(c.req.valid("json"));
					return r.ok
						? c.json(accuracy.accuracySettings(), 200)
						: c.json({ message: r.message, field: r.field }, 400);
				},
			)
			.get("/criteria", (c) => c.json(service.criteria()))
			.post(
				"/criteria",
				validator("json", (v, c) => {
					if (!isObj(v) || typeof v.text !== "string") {
						return c.json({ message: "text が必要" }, 400);
					}
					return {
						text: v.text,
						note: typeof v.note === "string" ? v.note : "",
					};
				}),
				(c) => {
					const { text, note } = c.req.valid("json");
					const r = service.addCriteria(text, note);
					return r.ok
						? c.json({ version: r.version }, 201)
						: c.json({ message: r.message, field: "text" }, 400);
				},
			)
			.put(
				"/criteria/active",
				validator("json", (v, c) => {
					if (!isObj(v) || !Number.isSafeInteger(v.version)) {
						return c.json({ message: "version が必要" }, 400);
					}
					return { version: v.version as number };
				}),
				(c) =>
					service.setActiveCriteria(c.req.valid("json").version)
						? c.json(service.criteria(), 200)
						: c.json({ message: "版が見つからない" }, 404),
			)
			.get("/model", (c) => c.json(service.models()))
			.put(
				"/model",
				validator("json", (v, c) => {
					if (!isObj(v) || typeof v.model !== "string") {
						return c.json({ message: "model が必要" }, 400);
					}
					return { model: v.model };
				}),
				(c) =>
					service.setModel(c.req.valid("json").model)
						? c.json(service.models(), 200)
						: c.json({ message: "選べないモデル" }, 400),
			)
			.get("/api-key", (c) => c.json(service.apiKey()))
			.put(
				"/api-key",
				validator("json", (v, c) => {
					if (!isObj(v) || typeof v.key !== "string") {
						return c.json({ message: "key が必要" }, 400);
					}
					return { key: v.key };
				}),
				(c) => {
					const r = service.setApiKey(c.req.valid("json").key);
					return r.ok
						? c.json(service.apiKey(), 200)
						: c.json({ message: r.message }, 400);
				},
			)
			.delete("/api-key", (c) => {
				service.deleteApiKey();
				return c.json(service.apiKey(), 200);
			})
			.post("/news/:id/retry", (c) =>
				service.retry(Number(c.req.param("id")))
					? c.json({ ok: true as const }, 200)
					: c.json({ message: "採点に失敗したニュースではない" }, 409),
			)
			// 運用の採点を使用中の版で採点し直す（ニュース画面から）
			.post("/news/:id/rescore", (c) => {
				const r = service.rescoreLive(Number(c.req.param("id")));
				if (!r.ok) return c.json({ message: r.message }, r.status);
				return r.requested
					? c.json({ version: r.version }, 200)
					: c.json(
							{ message: "使用中の版で採点済みか、採点済みのニュースではない" },
							409,
						);
			})
			.get(
				"/rescore",
				validator("query", (q) => ({
					from: Number(q.from),
					to: Number(q.to),
					version: Number(q.version),
				})),
				(c) => {
					const { from, to, version } = c.req.valid("query");
					const r = service.rescoreCoverage(from, to, version);
					return r.ok
						? c.json({ coverage: r.coverage }, 200)
						: c.json({ message: r.message }, r.status);
				},
			)
			.post(
				"/rescore",
				validator("json", (v, c) => {
					if (!isObj(v)) return c.json({ message: "形が違う" }, 400);
					return {
						from: Number(v.from),
						to: Number(v.to),
						version: Number(v.version),
					};
				}),
				(c) => {
					const { from, to, version } = c.req.valid("json");
					const r = service.requestRescore(from, to, version);
					return r.ok
						? c.json({ coverage: r.coverage }, 200)
						: c.json({ message: r.message }, r.status);
				},
			)
			.post(
				"/trial",
				validator("json", (v, c) => {
					if (!isObj(v) || typeof v.criteria !== "string") {
						return c.json({ message: "criteria が必要" }, 400);
					}
					if (
						v.newsIds !== undefined &&
						!(
							Array.isArray(v.newsIds) &&
							v.newsIds.every((x) => Number.isSafeInteger(x))
						)
					) {
						return c.json({ message: "newsIds は整数の配列にする" }, 400);
					}
					return {
						criteria: v.criteria,
						newsIds: v.newsIds as number[] | undefined,
					};
				}),
				async (c) => {
					const { criteria, newsIds } = c.req.valid("json");
					const r = await service.trial(criteria, newsIds);
					return r.ok ? c.json(r, 200) : c.json({ message: r.message }, 400);
				},
			)
	);
}
