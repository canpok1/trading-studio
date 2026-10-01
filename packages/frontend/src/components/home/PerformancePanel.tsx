// ホームの成績。口座のリセット以降の損益と勝率などの数字

import type { TradingPerformance } from "@trading-studio/backend";
import { formatDate, formatDateTime } from "../../format";
import {
	gradeMaxDrawdown,
	gradePnl,
	gradeProfitFactor,
	gradeWinRate,
} from "../../lib/grade";
import {
	formatSignedInt,
	formatSignedPercent,
	holdingText,
} from "../../lib/number";
import { Stat } from "../backtest/OrderViews";
import { FewTradesNote, GradeBadge, GradeHelp } from "../Grade";
import { Skeleton } from "../States";
import { PANEL, PanelHeader } from "./Panel";

const tone = (n: number | null) =>
	n === null ? "" : n >= 0 ? "text-profit" : "text-loss";

export function PerformancePanel({
	performance: p,
	error,
}: {
	performance: TradingPerformance | null;
	error: string | null;
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
					<div className="flex flex-col gap-0.5">
						<span className="flex items-center gap-1.5 text-xs text-text-2">
							開始からの損益
							<GradeBadge
								value={gradePnl(
									p.pnlPercent,
									p.buyHoldPercent,
									p.trades === 0 && p.position.quantity === 0,
								)}
							/>
						</span>
						<div className="flex items-baseline gap-2.5">
							<span
								data-testid="home-pnl"
								className={`num text-[26px] font-semibold tracking-tight ${tone(p.pnl)}`}
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
							{formatDateTime(p.resetAt)} から（口座のリセット以降）
							{p.buyHoldPercent !== null &&
								`。ガチホなら ${formatSignedPercent(p.buyHoldPercent)}`}
						</span>
					</div>
					<div className="grid grid-cols-3 gap-x-2 gap-y-3">
						<Stat
							label="確定損益"
							value={formatSignedInt(p.realizedPnl)}
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
				</>
			)}
		</section>
	);
}
