// 自動取引の口座の残高と成績。取引画面の上部に出す

import type { TradingPerformance } from "@trading-studio/backend";
import { formatBtc } from "@trading-studio/core";
import { formatDate, formatDateTime } from "../../format";
import {
	formatInt,
	formatSignedInt,
	formatSignedPercent,
	holdingText,
} from "../../lib/number";
import { Stat } from "../backtest/OrderViews";
import { Skeleton } from "../States";

const tone = (n: number | null) =>
	n === null ? "" : n >= 0 ? "text-profit" : "text-loss";

/** 損益・資産は今の価格で評価する。成績の数え方はバックテスト結果と同じ */
export function PerformanceCard({
	title,
	performance: p,
	error,
}: {
	title: string;
	performance: TradingPerformance | null;
	error: string | null;
}) {
	return (
		<section
			aria-label={title}
			className="flex flex-col gap-3.5 rounded-xl border border-line bg-surface px-4 py-3.5"
		>
			{p === null ? (
				error ? (
					<p role="alert" className="text-xs font-semibold text-loss">
						成績を読み込めなかった（{error}）。5秒ごとに読み直している
					</p>
				) : (
					<Skeleton className="h-24" />
				)
			) : (
				<>
					<div className="flex flex-col gap-0.5">
						<span className="text-xs text-text-2">{title}</span>
						<div className="flex items-baseline gap-2.5">
							<span
								data-testid="performance-pnl"
								className={`num text-[30px] font-semibold tracking-tight ${tone(p.pnl)}`}
							>
								{p.pnl === null ? "—" : `${formatSignedInt(p.pnl)}円`}
							</span>
							{p.pnlPercent !== null && (
								<span className={`num text-base font-semibold ${tone(p.pnl)}`}>
									{formatSignedPercent(p.pnlPercent)}
								</span>
							)}
						</div>
						<span className="num text-xs text-text-2">
							{formatDateTime(p.resetAt)} から（口座のリセット以降） ·
							開始時の資金 {formatInt(p.initialCash)}円
						</span>
					</div>
					<div className="grid grid-cols-3 gap-x-2 gap-y-3 border-t border-line pt-3 lg:grid-cols-9">
						<Stat
							label="総資産"
							value={p.equity === null ? "—" : formatInt(p.equity)}
						/>
						<Stat label="現金" value={formatInt(p.cash)} />
						<Stat label="保有 BTC" value={formatBtc(p.position.quantity)} />
						<Stat
							label="確定損益"
							value={formatSignedInt(p.realizedPnl)}
							tone={tone(p.realizedPnl)}
						/>
						<Stat
							label="評価損益"
							value={
								p.pnl === null ? "—" : formatSignedInt(p.pnl - p.realizedPnl)
							}
							tone={p.pnl === null ? "" : tone(p.pnl - p.realizedPnl)}
						/>
						<Stat
							label="勝率"
							value={p.winRate !== null ? `${p.winRate.toFixed(1)}%` : "—"}
							sub={`${p.wins}勝 ${p.losses}敗`}
						/>
						<Stat
							label="最大DD"
							value={
								p.maxDrawdownPercent > 0
									? `−${p.maxDrawdownPercent.toFixed(1)}%`
									: "0.0%"
							}
							tone="text-loss"
							sub={
								p.maxDrawdownFrom !== null && p.maxDrawdownTo !== null
									? `${formatDate(p.maxDrawdownFrom).slice(5)}〜${formatDate(p.maxDrawdownTo).slice(5)}`
									: undefined
							}
						/>
						<Stat
							label="損益比率（PF）"
							value={
								p.trades === 0
									? "—"
									: p.profitFactor === null
										? "∞"
										: p.profitFactor.toFixed(2)
							}
						/>
						<Stat
							label="取引回数"
							value={String(p.trades)}
							sub={`往復 · 平均保有 ${p.averageHoldingMs !== null ? holdingText(p.averageHoldingMs) : "—"}`}
						/>
					</div>
				</>
			)}
		</section>
	);
}
