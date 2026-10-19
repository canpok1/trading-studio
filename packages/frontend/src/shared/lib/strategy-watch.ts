// 戦略の見張り（今の価格での試算）を、ホームの「次の動き」・チャートの発動価格・「戦略の見張り」に向けて読み替える

import type {
	StrategyWatch,
	WatchActionKind,
	WatchBuyStatus,
	WatchGroup,
	WatchWait,
} from "@trading-studio/core";
import { PRICE_FREE, TIMEFRAME_LABELS } from "@trading-studio/core";
import { conditionText } from "./condition-text";
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

/** 価格で起きない売買1行ぶん。同じ買い・種類・理由のロットは1行にまとめる */
export type WaitLine = {
	key: string;
	kind: WatchWait["kind"];
	buyName: string;
	text: string;
};

export function waitLines(waits: WatchWait[], price: number): WaitLine[] {
	const out: WaitLine[] = [];
	const seen = new Set<string>();
	for (const w of waits) {
		const text = waitText(w, price);
		const key = `${w.kind}:${w.buyId}:${text}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ key, kind: w.kind, buyName: w.buyName, text });
	}
	return out;
}

/** 価格で起きない理由。例: 「センチメント +1（今 中立）が揃えば −1.20%で」 */
export function waitText(w: WatchWait, price: number): string {
	const r = w.reason;
	switch (r.kind) {
		case "buyStatus":
			return buyStatusText(r.status) ?? "";
		case "selling":
			return "売り注文の約定待ち";
		case "insufficient":
			return r.reason ? `判定できない（${r.reason}）` : "判定できない";
		case "conditions": {
			if (r.conditions.length === 0) {
				return "価格では届かない（条件の成立する価格が重ならない）";
			}
			const list = (cs: typeof r.conditions) =>
				cs
					.map((c) => {
						const t = conditionText(c.condition);
						return c.detail ? `${t}（${c.detail}）` : t;
					})
					.join("・");
			if (r.at === "now") return `${list(r.conditions)}が揃えば次の判定で`;
			if (r.at !== null) {
				return `${list(r.conditions)}が揃えば ${distanceText(r.at, price)}で`;
			}
			const free = r.conditions.filter((c) => PRICE_FREE.has(c.condition.type));
			const priced = r.conditions.filter(
				(c) => !PRICE_FREE.has(c.condition.type),
			);
			// 価格で決まる条件は、±50% で届かない・上下どちらでも入れ替わる・ADX（探さない）のどれかで発動価格が無い
			const noPrice = `発動価格を求められない（${list(priced)}）`;
			if (free.length === 0) return noPrice;
			return priced.length === 0
				? `${list(free)}を待つ`
				: `${list(free)}を待つ・${noPrice}`;
		}
	}
}

/** オフでも約定しうる未約定の注文（買いの約定待ち・売りの約定待ち）。オフは判定しないが、注文は約定する */
export function pendingOrderWaits(waits: WatchWait[]): WatchWait[] {
	return waits.filter(
		(w) =>
			w.reason.kind === "selling" ||
			(w.reason.kind === "buyStatus" && w.reason.status.kind === "waitingFill"),
	);
}

export const STOPPED_TEXT = "停止中のため新しい注文は出さない";
