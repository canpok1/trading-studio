// AI判定画面の表示の計算。描画に依存しない部分をここに置き、単体テストする

import type {
	CurrentJudgment,
	NewsCollectorStatus,
	NewsItem,
	ScorerStatus,
} from "@trading-studio/backend";
import { formatDateTime } from "../format";

/** AI判定画面が問い合わせて持つデータ */
export type AiData = {
	current: CurrentJudgment;
	news: NewsItem[];
	collector: NewsCollectorStatus;
	scorer: ScorerStatus;
};

export type Trouble = { title: string; lines: string[]; since: number | null };

/** 収集・採点が止まっている間だけ出す知らせ */
export function aiTroubles(
	collector: NewsCollectorStatus,
	scorer: ScorerStatus,
): Trouble[] {
	const out: Trouble[] = [];
	const failing = collector.sources.filter((s) => s.enabled && s.lastError);
	if (collector.state === "stopped") {
		out.push({
			title: "ニュースの収集が止まっている",
			lines: [
				collector.error ?? "",
				...failing.map((s) => `${s.name}: ${s.lastError}`),
			],
			since: collector.stoppedSince,
		});
	} else if (failing.length > 0) {
		// 一部の取得元だけ失敗している。収集は続いているので止まった時刻は取得元ごとに出す
		out.push({
			title: "一部の取得元から取得できていない",
			lines: failing.map(
				(s) =>
					`${s.name}: ${s.lastError}（${s.errorSince === null ? "" : `${formatDateTime(s.errorSince)} から`}）`,
			),
			since: null,
		});
	}
	if (scorer.state === "stopped") {
		out.push({
			title: "ニュースの採点が止まっている",
			lines: [
				scorer.error ?? "",
				`未採点のニュース ${scorer.pending} 件は、採点が戻ると順に採点する`,
			],
			since: scorer.stoppedSince,
		});
	}
	return out;
}

export type NewsState =
	| { kind: "done" }
	| { kind: "waiting"; stopped: boolean }
	| { kind: "retry"; error: string; nextAttemptAt: number | null }
	| { kind: "failed"; error: string }
	| { kind: "skipped" };

export function newsState(n: NewsItem, scorerStopped: boolean): NewsState {
	const s = n.score;
	if (!s) return { kind: "waiting", stopped: scorerStopped };
	switch (s.status) {
		case "done":
			return { kind: "done" };
		case "retry":
			return {
				kind: "retry",
				error: s.error ?? "",
				nextAttemptAt: s.nextAttemptAt,
			};
		case "failed":
			return { kind: "failed", error: s.error ?? "" };
		case "skipped":
			return { kind: "skipped" };
	}
}
