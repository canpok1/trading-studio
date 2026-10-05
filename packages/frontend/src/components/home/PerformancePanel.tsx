// ホームの成績。口座のリセット以降の確定損益・勝率などの数字。通算損益は要点のカードに出す

import type { TradingPerformance } from "@trading-studio/backend";
import { formatDate, formatDateTime } from "../../format";
import {
	gradeMaxDrawdown,
	gradeProfitFactor,
	gradeWinRate,
} from "../../lib/grade";
import { formatSignedInt, holdingText } from "../../lib/number";
import { Stat } from "../backtest/OrderViews";
import { FewTradesNote, GradeHelp } from "../Grade";
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
				</>
			)}
		</section>
	);
}
