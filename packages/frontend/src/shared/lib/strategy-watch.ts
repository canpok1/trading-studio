// 戦略の見張り（今の価格での試算）を、ホームの「次の動き」・チャートの発動価格・「戦略の見張り」に向けて読み替える

import type {
	StrategyWatch,
	WatchActionKind,
	WatchBuyStatus,
	WatchGroup,
} from "@trading-studio/core";
import { TIMEFRAME_LABELS } from "@trading-studio/core";
import { formatInt } from "./number";

/** チャートに引く発動価格 */
export type ChartTrigger = {
	price: number;
	kind: WatchActionKind;
};

export const ACTION_LABELS: Record<WatchActionKind, string> = {
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
			return "予定イベントの暦切れで判定しない";
	}
}

/** グループの成立した条件の数 */
export function metCount(g: WatchGroup): { met: number; total: number } {
	return {
		met: g.conditions.filter((c) => c.met === true).length,
		total: g.conditions.length,
	};
}
