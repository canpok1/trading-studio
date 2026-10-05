// ニュース画面の絞り込みの条件。URL の検索パラメータに持ち、API の問い合わせへ変える。描画に依存しない

import type { NewsImpact, NewsSort } from "@trading-studio/backend";
import type { Duration } from "@trading-studio/core";
import { DURATIONS } from "@trading-studio/core";
import { formatDate, fromDateInputValue } from "../format";

export const NEWS_PERIODS = ["all", "24h", "7d", "custom"] as const;
export type NewsPeriod = (typeof NEWS_PERIODS)[number];

export const IMPACT_LABELS: Record<NewsImpact, string> = {
	bull: "強気材料",
	bear: "弱気材料",
	risk: "リスク高",
};
const IMPACTS = Object.keys(IMPACT_LABELS) as NewsImpact[];

export const PERIOD_LABELS: Record<NewsPeriod, string> = {
	all: "すべて",
	"24h": "24時間",
	"7d": "7日",
	custom: "日付を指定",
};

export const SORT_LABELS: Record<NewsSort, string> = {
	new: "新しい順",
	impact: "影響の大きい順",
};

export type NewsFilterState = {
	period: NewsPeriod;
	/** 日付を指定するときの開始日・終了日（JST、input type="date" の値）。終了日の終わりまで含む */
	fromDate: string;
	toDate: string;
	impacts: NewsImpact[];
	durations: Duration[];
	/** 上の市場評価に使っている（重みが 0% より大きい）ものだけ */
	active: boolean;
	sort: NewsSort;
	q: string;
};

export const EMPTY_FILTER: NewsFilterState = {
	period: "all",
	fromDate: "",
	toDate: "",
	impacts: [],
	durations: [],
	active: false,
	sort: "new",
	q: "",
};

const DAY = 86_400_000;
const PRESET_MS: Partial<Record<NewsPeriod, number>> = {
	"24h": DAY,
	"7d": 7 * DAY,
};

/** URL の検索パラメータから読む。知らない値は既定に戻す */
export function parseNewsFilter(p: URLSearchParams): NewsFilterState {
	const period = p.get("period");
	const sort = p.get("sort");
	return {
		period: (NEWS_PERIODS as readonly (string | null)[]).includes(period)
			? (period as NewsPeriod)
			: "all",
		fromDate: p.get("from") ?? "",
		toDate: p.get("to") ?? "",
		impacts: IMPACTS.filter((i) =>
			(p.get("impact") ?? "").split(",").includes(i),
		),
		durations: DURATIONS.filter((d) =>
			(p.get("dur") ?? "").split(",").includes(d),
		),
		active: p.get("active") === "1",
		sort: sort === "impact" ? "impact" : "new",
		q: p.get("q") ?? "",
	};
}

/** URL の検索パラメータへ書く。既定の値は書かない */
export function newsFilterParams(f: NewsFilterState): URLSearchParams {
	const p = new URLSearchParams();
	if (f.period !== "all") p.set("period", f.period);
	if (f.period === "custom") {
		if (f.fromDate) p.set("from", f.fromDate);
		if (f.toDate) p.set("to", f.toDate);
	}
	if (f.impacts.length) p.set("impact", f.impacts.join(","));
	if (f.durations.length) p.set("dur", f.durations.join(","));
	if (f.active) p.set("active", "1");
	if (f.sort !== "new") p.set("sort", f.sort);
	if (f.q.trim()) p.set("q", f.q);
	return p;
}

/** 公開時刻の範囲 [from, to)。null は端なし */
export function newsRange(
	f: NewsFilterState,
	now: number,
): { from: number | null; to: number | null } {
	const preset = PRESET_MS[f.period];
	if (preset !== undefined) return { from: now - preset, to: null };
	if (f.period !== "custom") return { from: null, to: null };
	const from = fromDateInputValue(f.fromDate);
	const toStart = fromDateInputValue(f.toDate);
	return { from, to: toStart === null ? null : toStart + DAY };
}

/** API の問い合わせ */
export function newsQuery(
	f: NewsFilterState,
	now: number,
	limit: number,
): Record<string, string> {
	const { from, to } = newsRange(f, now);
	const q: Record<string, string> = { limit: String(limit) };
	if (from !== null) q.from = String(from);
	if (to !== null) q.to = String(to);
	if (f.impacts.length) q.impact = f.impacts.join(",");
	if (f.durations.length) q.duration = f.durations.join(",");
	if (f.active) q.active = String(evaluationTime(f, now) ?? now);
	if (f.sort !== "new") q.sort = f.sort;
	if (f.q.trim()) q.q = f.q.trim();
	return q;
}

/** 市場評価を出す時点。日付を指定して終わりが今より前なら、その終わり。それ以外は今（null） */
export function evaluationTime(f: NewsFilterState, now: number): number | null {
	if (f.period !== "custom") return null;
	const { to } = newsRange(f, now);
	return to !== null && to < now ? to : null;
}

/** 開始日が終了日より後なら誤り */
export function customRangeError(f: NewsFilterState): string | null {
	if (f.period !== "custom") return null;
	if (!f.fromDate && !f.toDate) return "開始日か終了日を入れる";
	if (f.fromDate && f.toDate && f.fromDate > f.toDate)
		return "開始日を終了日より前にする";
	return null;
}

/** 日付を指定したときのチップの文言。例: 9/1〜9/3、9/1〜、〜9/3 */
export function customRangeLabel(f: NewsFilterState): string {
	const short = (v: string) => {
		const ms = fromDateInputValue(v);
		if (ms === null) return "";
		const [, m, d] = formatDate(ms).split("/");
		return `${Number(m)}/${Number(d)}`;
	};
	const a = short(f.fromDate);
	const b = short(f.toDate);
	return a === b ? a : `${a}〜${b}`;
}

/** 「絞り込み」ボタンに出す、キーワード以外で既定から変えている条件の数 */
export function activeFilterCount(f: NewsFilterState): number {
	return (
		(f.period !== "all" ? 1 : 0) +
		f.impacts.length +
		f.durations.length +
		(f.active ? 1 : 0) +
		(f.sort !== "new" ? 1 : 0)
	);
}

export function isFiltered(f: NewsFilterState): boolean {
	return activeFilterCount(f) > 0 || f.q.trim() !== "";
}

/** 新しい順のときの日付の区切り。並びの中で日（JST）が変わる位置に見出しを入れる */
export function groupByDay<T extends { publishedAt: number }>(
	items: readonly T[],
): { day: string; items: T[] }[] {
	const out: { day: string; items: T[] }[] = [];
	for (const it of items) {
		const day = formatDate(it.publishedAt);
		const last = out.at(-1);
		if (last && last.day === day) last.items.push(it);
		else out.push({ day, items: [it] });
	}
	return out;
}
