// ホームの成績。口座のリセット以降の確定損益・勝率などの数字。通算損益は要点のカードに出す

import type {
	AutoTradingStatus,
	TradingPerformance,
} from "@trading-studio/backend";
import {
	formatQuantity,
	gradeMaxDrawdown,
	gradeProfitFactor,
	gradeWinRate,
} from "@trading-studio/core";
import { FewTradesNote, GradeHelp } from "../../../shared/components/Grade";
import { Stat } from "../../../shared/components/OrderViews";
import { Skeleton } from "../../../shared/components/States";
import { formatDate, formatDateTime } from "../../../shared/lib/format";
import { formatSignedInt, holdingText } from "../../../shared/lib/number";
import { PANEL, PanelHeader } from "./Panel";

const tone = (n: number | null) =>
	n === null ? "" : n >= 0 ? "text-profit" : "text-loss";

export function PerformancePanel({
	performance: p,
	error,
	status,
}: {
	performance: TradingPerformance | null;
	error: string | null;
	/** 候補が2つ以上なら、銘柄ごとの成績の表を出す */
	status: AutoTradingStatus;
}) {
	return (
		<section aria-label="成績" className={PANEL}>
			<PanelHeader title="成績" tag={<GradeHelp />} />
			{p === null ? (
				error ? (
					<p role="alert" className="text-xs font-semibold text-loss">
						成績を読み込めなかった（{error}）。5秒ごとに読み直している
					</p>
				) : (
					<Skeleton className="h-20" />
				)
			) : (
				<>
					<span className="num text-xs text-text-2">
						{formatDateTime(p.resetAt)} から（口座のリセット以降）
					</span>
					<div className="grid grid-cols-3 gap-x-2 gap-y-3">
						<Stat
							label="確定損益"
							value={`${formatSignedInt(p.realizedPnl)}円`}
							tone={tone(p.realizedPnl)}
						/>
						<Stat
							label="勝率"
							value={p.winRate !== null ? `${p.winRate.toFixed(1)}%` : "—"}
							sub={`${p.wins}勝 ${p.losses}敗`}
							grade={gradeWinRate(p.winRate)}
						/>
						<Stat
							label="最大DD"
							value={
								p.maxDrawdownPercent > 0
									? `−${p.maxDrawdownPercent.toFixed(1)}%`
									: "0.0%"
							}
							tone="text-loss"
							grade={gradeMaxDrawdown(p.maxDrawdownPercent)}
							sub={
								p.maxDrawdownFrom !== null && p.maxDrawdownTo !== null
									? `${formatDate(p.maxDrawdownFrom).slice(5)}〜${formatDate(p.maxDrawdownTo).slice(5)}`
									: undefined
							}
						/>
						<Stat
							label="PF"
							value={
								p.trades === 0
									? "—"
									: p.profitFactor === null
										? "∞"
										: p.profitFactor.toFixed(2)
							}
							grade={gradeProfitFactor(p.profitFactor, p.trades)}
						/>
						<Stat
							label="取引回数"
							value={String(p.trades)}
							sub={`平均保有 ${p.averageHoldingMs !== null ? holdingText(p.averageHoldingMs) : "—"}`}
						/>
					</div>
					<FewTradesNote trades={p.trades} />
					{p.byInstrument && status.instruments.length > 1 && (
						<InstrumentTable performance={p} status={status} />
					)}
				</>
			)}
		</section>
	);
}

const COLS = "grid grid-cols-[3rem_minmax(0,1fr)_2.5rem_minmax(0,1fr)] gap-2";

/** 銘柄ごとの確定損益・取引回数・保有。勝率・PF・最大DD は合計で見る */
function InstrumentTable({
	performance: p,
	status,
}: {
	performance: TradingPerformance;
	status: AutoTradingStatus;
}) {
	const held = (id: string) =>
		status.account.holdings.find((h) => h.instrument === id)?.position
			.quantity ?? 0;
	const heldCount = status.instruments.filter((i) => held(i.id) > 0).length;
	const rows = [
		{
			key: "total",
			label: "合計",
			pnl: p.realizedPnl,
			trades: p.trades,
			holding: heldCount > 0 ? `${heldCount}銘柄` : "—",
		},
		...status.instruments.map((i) => {
			const s = p.byInstrument?.[i.id];
			const q = held(i.id);
			return {
				key: i.id,
				label: i.quantityUnit,
				pnl: s?.realizedPnl ?? 0,
				trades: s?.trades ?? 0,
				holding: q > 0 ? `${formatQuantity(i, q)} ${i.quantityUnit}` : "—",
			};
		}),
	];
	return (
		<div className="flex flex-col border-t border-line pt-2">
			<div className={`${COLS} px-1 pb-1 text-xs text-text-2`} aria-hidden>
				<span>銘柄</span>
				<span className="text-right">確定損益</span>
				<span className="text-right">取引</span>
				<span className="text-right">保有</span>
			</div>
			<ul aria-label="銘柄ごとの成績">
				{rows.map((r) => (
					<li
						key={r.key}
						aria-label={`${r.label} 確定損益 ${formatSignedInt(r.pnl)}円・取引 ${r.trades}・保有 ${r.holding}`}
						className={`${COLS} num items-center border-t border-line px-1 py-2 text-[13px]`}
					>
						<span className="font-semibold">{r.label}</span>
						<span
							className={`text-right font-semibold [overflow-wrap:anywhere] ${tone(r.pnl)}`}
						>
							{formatSignedInt(r.pnl)}円
						</span>
						<span className="text-right">{r.trades}</span>
						<span className="text-right [overflow-wrap:anywhere]">
							{r.holding}
						</span>
					</li>
				))}
			</ul>
			<p className="pt-1 text-xs text-text-2">勝率・PF・最大DD は合計で出す</p>
		</div>
	);
}
