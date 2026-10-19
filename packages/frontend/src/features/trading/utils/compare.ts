// ホームのカードで比べる値。値と補足を、戦略の要約から作る

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
	/** 良し悪しの色。無ければ既定の字の色 */
	tone: "profit" | "loss" | null;
};

const signTone = (n: number | null) =>
	n === null ? null : n >= 0 ? "profit" : "loss";

export function compared(s: StrategySummary, key: CompareKey): Compared {
	const p = s.performance;
	if (!p) return { text: "—", sub: "成績を読めない", tone: null };
	const record = `${p.wins}勝 ${p.losses}敗`;
	switch (key) {
		case "pnl":
			return {
				text: p.pnl === null ? "—" : `${formatSignedInt(p.pnl)}円`,
				sub: p.pnlPercent === null ? "—" : formatSignedPercent(p.pnlPercent),
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
				tone: signTone(v),
			};
		}
		case "realized":
			return {
				text: `${formatSignedInt(p.realizedPnl)}円`,
				sub: `${p.trades}回`,
				tone: signTone(p.realizedPnl),
			};
		case "winRate":
			return {
				text: p.winRate === null ? "—" : `${p.winRate.toFixed(1)}%`,
				sub: record,
				tone: null,
			};
		case "profitFactor":
			// 負けが無ければ PF は ∞
			return {
				text:
					p.trades === 0
						? "—"
						: p.profitFactor === null
							? "∞"
							: p.profitFactor.toFixed(2),
				sub: record,
				tone: null,
			};
		case "maxDrawdown":
			return {
				text:
					p.maxDrawdownPercent > 0
						? `−${p.maxDrawdownPercent.toFixed(1)}%`
						: "0.0%",
				sub: "口座のリセット以降",
				tone: p.maxDrawdownPercent > 0 ? "loss" : null,
			};
		case "trades":
			return {
				text: `${p.trades}回`,
				sub: `平均保有 ${p.averageHoldingMs !== null ? holdingText(p.averageHoldingMs) : "—"}`,
				tone: null,
			};
	}
}
