import { Link, useLocation, useParams } from "react-router";
import { StrategyHeader } from "../../features/strategies/components/StrategyHeader";
import { StrategyDashboard } from "../../features/trading/components/StrategyDashboard";
import { Page } from "../../shared/components/Page";
import { EmptyState, LoadingCard } from "../../shared/components/States";
import { Card } from "../../shared/components/ui";
import { useTradingStatus } from "../../shared/lib/trading";

const BACK = "self-start text-[13px] font-semibold text-text-2 hover:text-text";

/** 戦略1つの画面。自動取引のオンオフ・編集への入口と、その戦略の要点・チャート・成績・注文 */
export function StrategyPage() {
	const { id } = useParams();
	const strategyId = Number(id);
	const { runs } = useTradingStatus();
	// 編集画面で保存したときの知らせ
	const notice = (useLocation().state as { notice?: string } | null)?.notice;
	const run = runs?.find((r) => r.id === strategyId) ?? null;

	if (!run) {
		return (
			<Page title="戦略" back={{ to: "/strategies", label: "戦略" }}>
				{runs === null ? (
					<LoadingCard />
				) : (
					<Card>
						<EmptyState
							title="戦略が見つからない"
							description="削除されたか、URL が違う。"
						/>
					</Card>
				)}
			</Page>
		);
	}
	return (
		<StrategyDashboard
			strategyId={run.id}
			head={(toast) => (
				<>
					<Link to="/strategies" className={`${BACK} lg:col-span-2`}>
						← 戦略
					</Link>
					<StrategyHeader key={run.id} run={run} onToast={toast} />
					{notice && (
						<p
							role="status"
							className="text-[13px] font-semibold lg:col-span-2"
						>
							{notice}
						</p>
					)}
				</>
			)}
		/>
	);
}
