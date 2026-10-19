// 戦略の見張り（今の価格での試算）を、ホームの「次の動き」・チャートの発動価格・「戦略の見張り」に向けて読み替える

import type {
	StrategyWatch,
	WatchActionKind,
	WatchBuyStatus,
	WatchGroup,
	WatchTrigger,
} from "@trading-studio/core";
import { jstDateTime, TIMEFRAME_LABELS } from "@trading-studio/core";
import { conditionText } from "./condition-text";
import { formatInt } from "./number";

/** チャートに引く発動価格 */
export type ChartTrigger = {
	price: number;
	kind: WatchActionKind;
};

export const ACTION_LABELS: Record<WatchActionKind | "sell", string> = {
	sell: "売り",
	entry: "買い",
	partialTakeProfit: "一部利確",
	takeProfit: "利確",
	stopLoss: "損切り",
};

/** 今の価格からの変化（小数2桁）。例: "+0.88%" */
export function distanceText(price: number, from: number): string {
	const p = (price / from - 1) * 100;
	return `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(2)}%`;
}

/** 今の価格から発動価格までの幅。% も円の差も符号付き */
export function moveText(
	price: number,
	from: number,
): { percent: string; yen: string } {
	const d = price - from;
	return {
		percent: distanceText(price, from),
		yen: `${d >= 0 ? "+" : "−"}${formatInt(Math.abs(d))} 円`,
	};
}

/** チャートに引く発動価格。同じ価格・同じ種類の線は1本にする */
export function chartTriggers(w: StrategyWatch | null): ChartTrigger[] {
	if (!w) return [];
	const seen = new Set<string>();
	const out: ChartTrigger[] = [];
	for (const a of w.actions) {
		if (a.price === null) continue;
		const key = `${a.kind}:${a.price}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ price: a.price, kind: a.kind });
	}
	return out;
}

/** 買いが次の判定で買わない理由。買えるなら null */
export function buyStatusText(s: WatchBuyStatus): string | null {
	switch (s.kind) {
		case "ready":
			return null;
		case "waitingFill":
			return "買い注文の約定待ち";
		case "full":
			return "最大ロット数に達していて買わない";
		case "cooldown":
			return `損切り後の待ち（${TIMEFRAME_LABELS[s.timeframe]}であと ${s.barsLeft} 本）`;
		case "continuing":
			return "条件が続いていて、一度外れるまで買わない";
		case "blocked":
			return s.reason;
		case "noCash":
			return "資金が足りず買わない";
		case "insufficient":
			return "指標の本数が足りず判定しない";
		case "noCalendar":
			return "予定の暦切れで判定しない";
	}
}

/** グループの成立した条件の数 */
export function metCount(g: WatchGroup): { met: number; total: number } {
	return {
		met: g.conditions.filter((c) => c.met === true).length,
		total: g.conditions.length,
	};
}

/** オフの戦略は判定しないが、出している注文は約定する */
export const STOPPED_TEXT = "停止中のため新しい注文は出さない";

/** 次の動き1行のきっかけ部分。icon は行頭の記号。「text（note）suffix」の順に並べる */
export type TriggerView = {
	icon: "●" | "↑" | "↓" | "⏱" | "◇" | "…";
	text: string;
	/** 円の差・今の値など。戦略の画面だけで出す */
	note: string | null;
	suffix: "で" | " から";
	/** 出している注文 */
	ordered: boolean;
};

/** 例: 「+10.00%（+1,000,000 円）で」「センチメント やや強気（今 中立）で」「あと 2 条件で」 */
export function triggerView(t: WatchTrigger, price: number): TriggerView {
	const priced = (p: number, ordered: boolean): TriggerView => {
		const m = moveText(p, price);
		return {
			icon: p > price ? "↑" : "↓",
			text: m.percent,
			note: m.yen,
			suffix: "で",
			ordered,
		};
	};
	switch (t.kind) {
		case "now":
			return {
				icon: "●",
				text: "次の判定",
				note: null,
				suffix: "で",
				ordered: false,
			};
		case "order":
			return t.price === null
				? { icon: "●", text: "成行", note: null, suffix: "で", ordered: true }
				: priced(t.price, true);
		case "price":
			return priced(t.price, false);
		case "bars":
			return {
				icon: "⏱",
				text: `あと ${t.bars} 本（${TIMEFRAME_LABELS[t.timeframe]}）`,
				note: null,
				suffix: "で",
				ordered: false,
			};
		case "time":
			return {
				icon: "⏱",
				text: jstDateTime(t.at),
				note: null,
				suffix: " から",
				ordered: false,
			};
		case "condition":
			return {
				icon: "◇",
				text: conditionText(t.condition),
				note: t.detail || null,
				suffix: "で",
				ordered: false,
			};
		case "remaining":
			return {
				icon: "…",
				text: `あと ${t.count} 条件`,
				note: null,
				suffix: "で",
				ordered: false,
			};
	}
}
