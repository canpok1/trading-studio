// MCP の道具のうち、scoring-analysis の機能のもの

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import type { ToolDeps } from "../mcp/tool-app";
import { atSchema, atTime, fail, readOnly, text } from "../mcp/tool-app";
import { analysisView, jst, parseTime } from "../mcp/views-domain";

export function registerScoringAnalysisTools(
	server: McpServer,
	{ accuracy }: ToolDeps,
) {
	server.registerTool(
		"get_market_evaluation_analysis",
		{
			description:
				"市場評価の分析（ニュース画面の評価詳細のタブと同じ）。記事ごとの精度（運用の採点の点数の段階と、公開時刻から測る長さの後の値動きの段階のずれ。一致で 5、1段ずれるごとに 1 下げる）を観点ごとに集計する。byPrecision は精度ごと、byLevel は記事の段階ごと、byLevelAndMove は記事の段階×値動きの段階の件数。criteriaVersion（プロンプトの版）・appVersion（採点したアプリのバージョン）・model（採点したモデル）で絞れる。期間と測る長さ、値動きの段階の境目は設定画面の「精度」の値（settings）。at で過去の時点を指定できる",
			inputSchema: {
				at: atSchema,
				criteriaVersion: z
					.number()
					.int()
					.optional()
					.describe("この版のプロンプトで採点した記事だけ数える。省けばすべて"),
				appVersion: z
					.string()
					.optional()
					.describe(
						'このバージョンのアプリで採点した記事だけ数える。options.appVersions の version（ISO 8601）か、記録前の採点は "none"。省けばすべて',
					),
				model: z
					.string()
					.min(1)
					.optional()
					.describe(
						'このモデルで採点した記事だけ数える。options.models の model（OpenAI 互換は openai: の印付き）か、モデルの記録が無い採点は "none"。省けばすべて',
					),
			},
			annotations: readOnly,
		},
		(a) => {
			const t = atTime(a.at);
			if ("isError" in t) return t;
			let appBuiltAt: number | "none" | undefined;
			if (a.appVersion === "none") appBuiltAt = "none";
			else if (a.appVersion !== undefined) {
				const v = parseTime(a.appVersion);
				if (v === null)
					return fail(
						'appVersion は options.appVersions の version（ISO 8601）か "none"',
					);
				appBuiltAt = v;
			}
			const r = accuracy.accuracySummary(t.at, {
				criteriaVersion: a.criteriaVersion,
				appBuiltAt,
				model: a.model,
			});
			const s = accuracy.accuracySettings();
			return text({
				time: jst(r.time),
				settings: {
					horizon: r.horizon,
					periodDays: r.periodDays,
					sentimentBandsPct: s.sentimentBands[r.horizon],
					riskBandsPct: s.riskBands[r.horizon],
				},
				filter: {
					criteriaVersion: r.filter.criteriaVersion,
					appVersion:
						typeof r.filter.appBuiltAt === "number"
							? jst(r.filter.appBuiltAt)
							: r.filter.appBuiltAt,
					model: r.filter.model,
				},
				options: {
					criteriaVersions: r.options.criteriaVersions.map((o) => ({
						...o,
						active: o.version === r.options.activeCriteriaVersion,
					})),
					appVersions: r.options.appBuiltAts.map((o) => ({
						version: o.builtAt === null ? "none" : jst(o.builtAt),
						count: o.count,
					})),
					models: r.options.models.map((o) => ({
						model: o.model ?? "none",
						count: o.count,
						active: o.model === r.options.activeModel,
					})),
				},
				results: {
					sentiment: analysisView("sentiment", r.results.sentiment),
					risk: analysisView("risk", r.results.risk),
				},
				note: "数えるのは公開時刻が time から periodDays 日（null はすべて）遡った時刻より後で time 以前の記事（filter で版・モデルを絞ったときはそれで採点したものだけ。採点し直して置き換えた記事は置き換えた後の版・モデル）。options は期間内で数える記事がある版・モデルと、絞る前の件数。モデルごとに採点した時期が違うので、モデルの違いと時期（相場・記事）の違いは分けられない。測定中・値動き不明・持続なし・採点済みでない記事は数えない。記事の段階は今の評価基準で点数から出す。センチメントは値動きの5段階（大きく下落〜大きく上昇）と、リスクは値動きの大きさの5段階（静か〜大荒れ）と、平常＝静か・…・危機＝大荒れ として比べる。sentimentBandsPct は small 未満が横ばい・large 以上が大きく動いた、riskBandsPct はそれぞれの段階の始まり（上下とも同じ幅の騰落率 %）",
			});
		},
	);
}
