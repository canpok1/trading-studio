// MCP の道具のうち、news の機能のもの

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { durationSchema } from "../mcp/schemas-domain";
import type { ToolDeps } from "../mcp/tool-app";
import { fail, readOnly, text } from "../mcp/tool-app";
import { jst, newsView, parseTime } from "../mcp/views-domain";
import {
	NEWS_IMPACTS,
	NEWS_LIST_MAX,
	NEWS_SORTS,
	TRIAL_MAX_NEWS,
} from "./types-domain";

export function registerNewsTools(
	server: McpServer,
	{ scoring, news, judgments, accuracy }: ToolDeps,
) {
	server.registerTool(
		"get_scoring_setup",
		{
			description:
				"ニュースの AI 採点の仕組み: プロンプトの固定のひな形（{news} と {criteria} を差し込む）、採点の基準（編集できる部分）の全版と使用中の版、モデル、点数から市場評価を出す評価ルール（コード上の名前は aggregationRule）、採点の状態",
			annotations: readOnly,
		},
		() => {
			const c = scoring.criteria();
			const st = scoring.status();
			return text({
				template: c.template,
				criteria: c.versions.map((v) => ({
					version: v.version,
					active: v.version === c.activeVersion,
					note: v.note,
					createdAt: jst(v.createdAt),
					text: v.text,
				})),
				model: scoring.models(),
				aggregationRule: judgments.rule(),
				aggregationRuleNote:
					"判定は、採点済みのニュースの点数を重み付き平均にし、thresholds と比べて出す。重みは新しさの時刻（公開時刻と取得時刻の早いほう）に 1 で、ニュースの duration（AI が付けた影響の持続。short・medium・long）ごとの halfLifeHours で半分になり、半減期の 4 倍たったら 0。duration が none（相場に関係ない）のニュースは重み 0。重み 0 のニュースは平均に入れない。sentiment: plus2 以上=+2・plus1 以上=+1・minus2 未満=-2・minus1 未満=-1。risk: mild 以上=やや警戒・alert 以上=警戒・severe 以上=かなり警戒・crisis 以上=危機（mild 未満=平常）",
				status: {
					state: st.state,
					error: st.error,
					pending: st.pending,
				},
				rules:
					"運用の採点は1記事1回で、採点済みは基準や版を変えても採点し直さない。使用する版を切り替えると次に採点するニュースから使う。運用の判定では採点時刻より前には使わない。バックテストでは公開時刻に取得の間隔を足した時刻から使う。過去の記事を別の版で試すには rescore_news で採点し直し、run_backtest の criteriaVersion で版を指定する",
			});
		},
	);

	server.registerTool(
		"list_news_scores",
		{
			description:
				"ニュースと AI の採点（点数・持続・理由・基準の版・モデル）、市場評価での重み、記事ごとの精度。scores・duration は市場全体、instruments は記事が個別に関係する銘柄の点数（銘柄の id → 点数と持続。無い銘柄は市場全体の点数で評価する）。重みと精度は BTC/JPY に対する評価のもの。ニュース画面の一覧と同じ条件で絞れる。weight は市場評価の時点（to が今より前ならその時刻、それ以外は今）での重み（0〜1）。precision は get_market_evaluation_analysis と同じ精度で、measuring は測る長さがまだたっていない、unknown は価格が無い、null は持続なし・採点済みでない記事。rescore は画面から頼んだ運用の採点の置き換え（採点し直し）で終わっていないもの。status は running: 採点し直し中 / waiting: 順番待ち（ahead は先に採点し直す件数。採点し直し中の1件とバックテスト用の分を含む。新着の採点が先） / retry: 失敗して nextAttemptAt に再試行 / failed: 失敗して止まっている",
			inputSchema: {
				from: z
					.string()
					.optional()
					.describe(
						"公開時刻の始まり。ISO 8601（タイムゾーン付き）か YYYY-MM-DD（JST）",
					),
				to: z
					.string()
					.optional()
					.describe("公開時刻の終わり（含まない）。書き方は from と同じ"),
				q: z
					.string()
					.max(200)
					.default("")
					.describe(
						"空白で区切った語をすべて含むもの（見出し・概要・採点の理由のどれかに。英字の大小は区別しない）",
					),
				impacts: z
					.array(z.enum(NEWS_IMPACTS))
					.default([])
					.describe(
						"影響の大きさ（今の評価基準で測る）。どれかに当てはまる採点済みのもの。bull: 強気材料（やや強気以上） / bear: 弱気材料（やや弱気以下） / risk: リスク高（警戒以上）",
					),
				durations: z
					.array(durationSchema)
					.default([])
					.describe("持続。どれかに当てはまる採点済みのもの"),
				active: z
					.boolean()
					.default(false)
					.describe(
						"市場評価の時点で評価に使っている（重みが 0 より大きい）ものだけ",
					),
				sort: z
					.enum(NEWS_SORTS)
					.default("new")
					.describe(
						"new: 新しい順 / impact: 影響の大きい順（センチメントの点数の絶対値とリスクの点数の大きい方。採点済みでないものは最後）",
					),
				offset: z.number().int().min(0).default(0),
				limit: z.number().int().min(1).max(200).default(50),
			},
			annotations: readOnly,
		},
		(a) => {
			const from = a.from === undefined ? null : parseTime(a.from);
			const to = a.to === undefined ? null : parseTime(a.to);
			if (
				(a.from !== undefined && from === null) ||
				(a.to !== undefined && to === null)
			) {
				return fail(
					"from・to はタイムゾーン付きの ISO 8601 か YYYY-MM-DD で書く",
				);
			}
			// 画面の一覧が読めるのは 1000 件まで
			if (a.offset + a.limit > NEWS_LIST_MAX) {
				return fail(`offset + limit は ${NEWS_LIST_MAX} 以下にする`);
			}
			// 画面と同じく、市場評価の時点は to が今より前ならその時刻（先の時刻は今になる）
			const c = judgments.current(undefined, to ?? undefined);
			const r = news.searchNews({
				from,
				to,
				q: a.q.trim(),
				impacts: a.impacts,
				durations: a.durations,
				activeAt: a.active ? c.time : null,
				sort: a.sort,
				limit: a.offset + a.limit,
			});
			const items = r.news.slice(a.offset);
			const acc = accuracy.articleAccuracy(items.map((n) => n.id));
			const byId = new Map(acc.items.map((x) => [x.id, x]));
			return text({
				total: r.total,
				evaluationTime: jst(c.time),
				precisionHorizon: acc.horizon,
				items: items.map((n) =>
					newsView(n, c.weights[String(n.id)], byId.get(n.id)),
				),
			});
		},
	);

	server.registerTool(
		"trial_scoring",
		{
			description: `採点の基準の案で、指定した過去のニュース（${TRIAL_MAX_NEWS} 件まで。省けば最新の1件）を採点し直す。保存も集計への反映もしない。保存済みの採点と並べて返す（設定画面のプロンプトの試し採点と同じ）。AI の回数制限のため1件につき5秒ほどかかる`,
			inputSchema: {
				criteria: z.string().describe("採点の基準の案（ひな形の {criteria}）"),
				newsIds: z.array(z.number().int()).max(TRIAL_MAX_NEWS).optional(),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ criteria, newsIds }) => {
			const r = await scoring.trial(criteria, newsIds);
			if (!r.ok) return fail(r.message);
			return text(
				r.items.map((x) => ({
					news: { ...x.news, publishedAt: jst(x.news.publishedAt) },
					result: x.result,
				})),
			);
		},
	);

	server.registerTool(
		"rescore_news",
		{
			description:
				"バックテストの期間の市場評価に使うニュースを、保存済みの基準の版で採点し直して保存する（運用の採点は変えない）。run_backtest で criteriaVersion を指定するのに使う。採点は裏で1件5秒ほどかけて進むので、同じ引数で呼び直して進み具合（coverage）を見る。失敗したものは呼び直すと再び採点する",
			inputSchema: {
				version: z.number().int(),
				from: z
					.string()
					.describe(
						"バックテストの開始。ISO 8601（タイムゾーン付き）か YYYY-MM-DD（JST）",
					),
				to: z
					.string()
					.describe("バックテストの終了（含まない）。書き方は from と同じ"),
			},
			annotations: { destructiveHint: false, openWorldHint: true },
		},
		(a) => {
			const from = parseTime(a.from);
			const to = parseTime(a.to);
			if (from === null || to === null) {
				return fail(
					"from・to はタイムゾーン付きの ISO 8601 か YYYY-MM-DD で書く",
				);
			}
			const r = scoring.requestRescore(from, to, a.version);
			if (!r.ok) return fail(r.message);
			return text({
				coverage: r.coverage,
				note: "done + failed = total になれば run_backtest で criteriaVersion を指定できる。failed の記事は除いて実行する",
			});
		},
	);

	server.registerTool(
		"add_scoring_criteria",
		{
			description:
				"採点の基準を新しい版として保存する。使用する版は切り替えない（set_active_scoring_criteria で切り替える）",
			inputSchema: {
				text: z.string().describe("採点の基準（4000 文字以内）"),
				note: z.string().describe("版の説明（100 文字以内）。何を変えたか"),
			},
			annotations: { destructiveHint: false, openWorldHint: false },
		},
		(a) => {
			const r = scoring.addCriteria(
				a.text,
				a.note.trim() || "Claude Code から",
			);
			if (!r.ok) return fail(r.message);
			return text({
				version: r.version.version,
				note: r.version.note,
				createdAt: jst(r.version.createdAt),
			});
		},
	);

	server.registerTool(
		"set_active_scoring_criteria",
		{
			description:
				"採点に使う基準の版を切り替える。次に採点するニュースから使い、自動取引の判定にも効く。採点済みのニュースは採点し直さない。切り替える前に利用者に確認を取る",
			inputSchema: { version: z.number().int() },
			annotations: {
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		({ version }) => {
			if (!scoring.setActiveCriteria(version)) return fail("版が見つからない");
			return text({ activeVersion: scoring.criteria().activeVersion });
		},
	);
}
