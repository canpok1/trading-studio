// ホームのカードで比べる値。値・補足・大小の棒の長さを、戦略の要約から作る

import type { StrategySummary } from "@trading-studio/backend";
import { unrealizedPnl } from "@trading-studio/core";
import {
	formatSignedInt,
	formatSignedPercent,
	holdingText,
} from "../../../shared/lib/number";

export const COMPARE_KEYS = [
	"pnl",
	"unrealized",
	"realized",
	"winRate",
	"profitFactor",
	"maxDrawdown",
	"trades",
] as const;
export type CompareKey = (typeof COMPARE_KEYS)[number];

export const COMPARE_LABELS: Record<CompareKey, string> = {
	pnl: "通算損益",
	unrealized: "含み損益",
	realized: "確定損益",
	winRate: "勝率",
	profitFactor: "PF",
	maxDrawdown: "最大DD",
	trades: "取引回数",
};

export const isCompareKey = (v: unknown): v is CompareKey =>
	COMPARE_KEYS.includes(v as CompareKey);

export type Compared = {
	text: string;
	sub: string;
	/** 棒の長さに使う値。損益は符号付き（0 を中央に左右へ）、他は 0 以上（左から）。無ければ null */
	amount: number | null;
	/** 良し悪しの色。無ければ既定の字の色 */
	tone: "profit" | "loss" | null;
};

const signTone = (n: number | null) =>
	n === null ? null : n >= 0 ? "profit" : "loss";

/** 損益は 0 を中央に左右へ伸ばす */
export const SIGNED: Record<CompareKey, boolean> = {
	pnl: true,
	unrealized: true,
	realized: true,
	winRate: false,
	profitFactor: false,
	maxDrawdown: false,
	trades: false,
};

export function compared(s: StrategySummary, key: CompareKey): Compared {
	const p = s.performance;
	if (!p) return { text: "—", sub: "成績を読めない", amount: null, tone: null };
	const record = `${p.wins}勝 ${p.losses}敗`;
	switch (key) {
		case "pnl":
			return {
				text: p.pnl === null ? "—" : `${formatSignedInt(p.pnl)}円`,
				sub: p.pnlPercent === null ? "—" : formatSignedPercent(p.pnlPercent),
				amount: p.pnl,
				tone: signTone(p.pnl),
			};
		case "unrealized": {
			const v = unrealizedPnl(
				p.position.quantity,
				p.position.entryPrice,
				p.price,
			);
			const lots = s.status.account.lots.length;
			return {
				text: v === null ? "—" : `${formatSignedInt(v)}円`,
				sub: lots > 0 ? `保有 ${lots} ロット` : "保有なし",
				amount: v,
				tone: signTone(v),
			};
		}
		case "realized":
			return {
				text: `${formatSignedInt(p.realizedPnl)}円`,
				sub: `${p.trades}回`,
				amount: p.realizedPnl,
				tone: signTone(p.realizedPnl),
			};
		case "winRate":
			return {
				text: p.winRate === null ? "—" : `${p.winRate.toFixed(1)}%`,
				sub: record,
				amount: p.winRate,
				tone: null,
			};
		case "profitFactor":
			// 負けが無ければ PF は ∞。棒は一番長くする
			return {
				text:
					p.trades === 0
						? "—"
						: p.profitFactor === null
							? "∞"
							: p.profitFactor.toFixed(2),
				sub: record,
				amount:
					p.trades === 0
						? null
						: p.profitFactor === null
							? Number.POSITIVE_INFINITY
							: p.profitFactor,
				tone: null,
			};
		case "maxDrawdown":
			return {
				text:
					p.maxDrawdownPercent > 0
						? `−${p.maxDrawdownPercent.toFixed(1)}%`
						: "0.0%",
				sub: "口座のリセット以降",
				amount: p.maxDrawdownPercent,
				tone: p.maxDrawdownPercent > 0 ? "loss" : null,
			};
		case "trades":
			return {
				text: `${p.trades}回`,
				sub: `平均保有 ${p.averageHoldingMs !== null ? holdingText(p.averageHoldingMs) : "—"}`,
				amount: p.trades,
				tone: null,
			};
	}
}

/**
 * 棒の位置（% で左端と幅）。並べたカードの中で一番大きい値を目いっぱいにする。
 * 損益は中央から左右に（幅は最大で半分）、他は左から
 */
export function barOf(
	amount: number | null,
	all: readonly (number | null)[],
	signed: boolean,
): { left: number; width: number } | null {
	if (amount === null) return null;
	const finite = all.filter(
		(v): v is number => v !== null && Number.isFinite(v),
	);
	const max = Math.max(0, ...finite.map(Math.abs));
	const ratio = !Number.isFinite(amount)
		? 1
		: max === 0
			? 0
			: Math.abs(amount) / max;
	if (!signed) return { left: 0, width: ratio * 100 };
	const width = ratio * 50;
	return { left: amount >= 0 ? 50 : 50 - width, width };
}
