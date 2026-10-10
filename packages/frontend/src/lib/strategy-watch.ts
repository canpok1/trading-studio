// 戦略の見張り（今の価格での試算）を、ホームの「次の動き」・チャートの発動価格・「戦略の見張り」に向けて読み替える

import type {
	StrategyWatch,
	WatchAction,
	WatchActionKind,
	WatchBuyStatus,
	WatchGroup,
} from "@trading-studio/core";
import { TIMEFRAME_LABELS } from "@trading-studio/core";

/** チャートに引く発動価格。near は「次の動き」に出す上側・下側で一番近いもので、縦の範囲に含めて画面に入れる */
export type ChartTrigger = {
	price: number;
	kind: WatchActionKind;
	near: boolean;
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

/**
 * 「次の動き」に出す売買。次の判定で起きるもの（価格なし）と、今の価格に一番近い上側・下側の発動価格を1つずつ。
 * 同じ価格なら損切り > 利確 > 一部利確 > 買い の順（判定で同時に成り立ったときの売りの優先と合わせる）
 */
export function nextMoves(w: StrategyWatch): {
	now: WatchAction[];
	up: WatchAction | null;
	down: WatchAction | null;
} {
	const rank: Record<WatchActionKind, number> = {
		stopLoss: 0,
		takeProfit: 1,
		partialTakeProfit: 2,
		entry: 3,
	};
	const now = w.actions.filter((a) => a.price === null);
	const priced = w.actions.filter(
		(a): a is WatchAction & { price: number } => a.price !== null,
	);
	const pick = (list: (WatchAction & { price: number })[], up: boolean) =>
		[...list].sort(
			(a, b) =>
				(up ? a.price - b.price : b.price - a.price) ||
				rank[a.kind] - rank[b.kind],
		)[0] ?? null;
	return {
		now,
		up: pick(
			priced.filter((a) => a.price > w.price),
			true,
		),
		down: pick(
			priced.filter((a) => a.price <= w.price),
			false,
		),
	};
}

/** チャートに引く発動価格。同じ価格・同じ種類の線は1本にする */
export function chartTriggers(w: StrategyWatch | null): ChartTrigger[] {
	if (!w) return [];
	const { up, down } = nextMoves(w);
	const seen = new Set<string>();
	const out: ChartTrigger[] = [];
	for (const a of w.actions) {
		if (a.price === null) continue;
		const key = `${a.kind}:${a.price}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({
			price: a.price,
			kind: a.kind,
			near: a.price === up?.price || a.price === down?.price,
		});
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
	}
}

/** グループの成立した条件の数 */
export function metCount(g: WatchGroup): { met: number; total: number } {
	return {
		met: g.conditions.filter((c) => c.met === true).length,
		total: g.conditions.length,
	};
}
