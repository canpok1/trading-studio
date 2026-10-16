// MCP の道具のうち、予定（calendar）の機能のもの。取得元と評価基準の変更は道具にしない（画面から人が行う）

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import type { ToolDeps } from "../mcp/tool-app";
import { fail, readOnly, text } from "../mcp/tool-app";
import { jst, parseTime } from "../mcp/views-domain";
import type { ListedEvent } from "./types-domain";

const eventView = (e: ListedEvent) => {
	const j = e.judgment;
	return {
		id: e.id,
		title: e.title,
		start: jst(e.start),
		allDay: e.allDay,
		source: e.sourceName ?? "アプリが持つ過去の予定",
		description: e.description,
		judgment:
			j === null
				? { status: "waiting" }
				: j.status === "done"
					? {
							status: "done",
							importance: j.importance,
							reason: j.reason,
							judgedAt: jst(j.judgedAt),
							model: j.model,
						}
					: j.status === "failed"
						? { status: "failed", attempts: j.attempts, error: j.error }
						: {
								status: j.status,
								attempts: j.attempts,
								error: j.error,
								nextAttemptAt:
									j.nextAttemptAt === null ? null : jst(j.nextAttemptAt),
							},
	};
};

export function registerCalendarTools(
	server: McpServer,
	{ calendar }: ToolDeps,
) {
	server.registerTool(
		"get_event_setup",
		{
			description:
				"予定（買いの条件 eventWindow「予定の前後でない」に使う）の仕組み: 取得元（iCal）の一覧と取得の状態、暦のそろっている終わり、重要度を判断するプロンプトの固定のひな形（{event} と {criteria} を差し込む）、予定の評価基準（編集できる部分）の全版と使用中の版、未判断・失敗の件数（設定画面の「ニュース」→「予定」）",
			annotations: readOnly,
		},
		() => {
			const c = calendar.criteria();
			const st = calendar.status();
			return text({
				sources: calendar.listSources().map((s) => ({
					name: s.name,
					url: s.url,
					lastSuccessAt: s.lastSuccessAt === null ? null : jst(s.lastSuccessAt),
					lastError: s.lastError,
				})),
				coveredUntil: st.coveredUntil === null ? null : jst(st.coveredUntil),
				unjudged: st.unjudged,
				failed: st.failed,
				template: c.template,
				criteria: c.versions.map((v) => ({
					version: v.version,
					active: v.version === c.activeVersion,
					note: v.note,
					createdAt: jst(v.createdAt),
					text: v.text,
				})),
				rules:
					"予定ごとに AI が重要度（high・medium・low）を判断する。判断はニュースの採点と問い合わせの間隔を共有して1件ずつ進む。運用は使用中の版の判断を使い、run_backtest・run_dataset は eventCriteriaVersion で版を選べる。判断していない・失敗した予定が条件の範囲にあれば暦切れ",
			});
		},
	);

	server.registerTool(
		"list_events",
		{
			description:
				"予定と重要度の判断（ニュース画面の予定のタブ）。期間に掛かる予定を始まりの順に。judgment.status は done: 判断済み / waiting: まだ判断していない / pending: 判断を頼まれて待っている / retry: 失敗して nextAttemptAt に再試行 / failed: 失敗して止まっている",
			inputSchema: {
				from: z
					.string()
					.describe(
						"期間の始まり。ISO 8601（タイムゾーン付き）か YYYY-MM-DD（JST）",
					),
				to: z.string().describe("期間の終わり。書き方は from と同じ"),
				version: z
					.number()
					.int()
					.optional()
					.describe("予定の評価基準の版。省くと使用中の版"),
				minImportance: z
					.enum(["high", "medium", "low"])
					.optional()
					.describe(
						"判断済みでこれより低い予定を除く（判断していない予定は残す）",
					),
				limit: z.number().int().min(1).max(500).default(100),
			},
			annotations: readOnly,
		},
		(a) => {
			const from = parseTime(a.from);
			const to = parseTime(a.to);
			if (from === null || to === null) {
				return fail(
					"from・to はタイムゾーン付きの ISO 8601 か YYYY-MM-DD で書く",
				);
			}
			const r = calendar.listEvents({
				from,
				to,
				version: a.version,
				minImportance: a.minImportance,
			});
			if (!r) return fail("予定の評価基準の版が見つからない");
			return text({
				version: r.version,
				total: r.total,
				items: r.events.slice(0, a.limit).map(eventView),
			});
		},
	);
}
