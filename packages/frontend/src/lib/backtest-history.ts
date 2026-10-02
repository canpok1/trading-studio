// バックテストの履歴の絞り込みの条件。URL の検索パラメータに持ち、API の問い合わせへ変える。描画に依存しない

import type { RunSort } from "@trading-studio/backend";

export const RUN_SORT_LABELS: Record<RunSort, string> = {
	new: "新しい順",
	pnl: "損益の高い順",
};

export type RunFilterState = {
	q: string;
	/** 失敗・中止を隠す */
	hideFailed: boolean;
	sort: RunSort;
};

/** URL の検索パラメータから読む。知らない値は既定に戻す */
export function parseRunFilter(p: URLSearchParams): RunFilterState {
	return {
		q: p.get("q") ?? "",
		hideFailed: p.get("hide") === "failed",
		sort: p.get("sort") === "pnl" ? "pnl" : "new",
	};
}

/** URL の検索パラメータへ書く。既定の値は書かない。履歴のタブを開いたままにする */
export function runFilterParams(f: RunFilterState): URLSearchParams {
	const p = new URLSearchParams({ tab: "history" });
	if (f.q.trim()) p.set("q", f.q);
	if (f.hideFailed) p.set("hide", "failed");
	if (f.sort !== "new") p.set("sort", f.sort);
	return p;
}

/** API の問い合わせ */
export function runQuery(
	f: RunFilterState,
	limit: number,
): Record<string, string> {
	const q: Record<string, string> = { limit: String(limit) };
	if (f.q.trim()) q.q = f.q.trim();
	if (f.hideFailed) q.hideFailed = "1";
	if (f.sort !== "new") q.sort = f.sort;
	return q;
}
