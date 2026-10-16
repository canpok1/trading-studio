// 戦略の一覧。行ごとに状態のバッジとモード・通算損益を出し、押すと戦略の画面へ。オンオフは戦略の画面で行う

import type { AutoTradingStatus } from "@trading-studio/backend";
import { Link } from "react-router";
import { formatSignedInt } from "../../../shared/lib/number";
import { MODE_LABELS } from "../../../shared/lib/trading";

/** 口座をリセットしてからの損益。保有があって価格が分からなければ null */
function totalPnl(r: AutoTradingStatus): number | null {
	return r.account.equity === null
		? null
		: r.account.equity - r.account.initialCash;
}

export function StrategyList({ runs }: { runs: AutoTradingStatus[] }) {
	return (
		<ul
			aria-label="戦略の一覧"
			className="overflow-hidden rounded-xl bg-surface lg:col-span-2"
		>
			{runs.map((r) => {
				const pnl = totalPnl(r);
				return (
					<li key={r.id} className="border-b border-line last:border-b-0">
						<Link
							to={`/strategies/${r.id}`}
							className="flex items-center gap-3 px-3.5 py-3 hover:bg-surface-2"
						>
							<span className="flex min-w-0 flex-1 flex-col gap-0.5">
								<strong className="truncate text-[15px]">{r.name}</strong>
								<span className="text-xs text-text-2">
									{MODE_LABELS[r.mode]}
									<span className="ml-3">
										{r.ranSinceReset ? (
											<>
												通算{" "}
												<span
													className={`num font-semibold ${pnl === null ? "" : pnl >= 0 ? "text-profit" : "text-loss"}`}
												>
													{pnl === null ? "—" : `${formatSignedInt(pnl)} 円`}
												</span>
											</>
										) : (
											"まだ動かしていない"
										)}
									</span>
								</span>
							</span>
							<span
								data-testid="strategy-state"
								className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold whitespace-nowrap ${r.enabled ? "bg-profit/15 text-profit" : "bg-surface-2 text-text-2"}`}
							>
								{r.enabled ? "● 稼働中" : "停止中"}
							</span>
							<span aria-hidden className="text-text-2">
								›
							</span>
						</Link>
					</li>
				);
			})}
		</ul>
	);
}
