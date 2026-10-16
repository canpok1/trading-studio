import { TRADING_LIMITS } from "@trading-studio/core";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { CreateStrategyDialog } from "../../features/strategies/components/StrategyDialogs";
import { StrategyList } from "../../features/strategies/components/StrategyList";
import { Page } from "../../shared/components/Page";
import { EmptyState, LoadingCard } from "../../shared/components/States";
import { Button, Card } from "../../shared/components/ui";
import { useTradingStatus } from "../../shared/lib/trading";

export function StrategiesPage() {
	const navigate = useNavigate();
	const location = useLocation();
	const { runs, refresh } = useTradingStatus();
	const [creating, setCreating] = useState(false);
	// 戦略の画面で削除したときの知らせ
	const notice = (location.state as { notice?: string } | null)?.notice;
	const running = runs?.filter((r) => r.enabled).length ?? 0;
	const createButton = (
		<Button variant="primary" onClick={() => setCreating(true)}>
			＋ 新しい戦略
		</Button>
	);

	return (
		<Page
			title="戦略"
			help="行を押すと戦略の画面へ。自動取引のオン・オフと条件の編集はそこで行う。"
			actions={runs && runs.length > 0 ? createButton : undefined}
		>
			{notice && (
				<p role="status" className="text-[13px] font-semibold">
					{notice}
				</p>
			)}
			{runs === null ? (
				<LoadingCard />
			) : runs.length === 0 ? (
				<Card>
					<EmptyState
						title="戦略がまだ無い"
						description="ひな形から作って、条件を調整する。"
						action={createButton}
					/>
				</Card>
			) : (
				<>
					<p className="text-xs text-text-2">
						稼働中 {running} / {TRADING_LIMITS.running}
					</p>
					<StrategyList runs={runs} />
				</>
			)}
			{creating && (
				<CreateStrategyDialog
					copyFrom={null}
					onClose={() => setCreating(false)}
					onCreated={(s) => {
						refresh();
						navigate(`/strategies/${s.id}/edit`);
					}}
				/>
			)}
		</Page>
	);
}
