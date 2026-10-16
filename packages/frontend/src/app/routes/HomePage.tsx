import { Navigate, useSearchParams } from "react-router";
import {
	HomeStrategies,
	markTargetOf,
	useMarkTarget,
	useStrategySummaries,
} from "../../features/trading/components/HomeStrategies";
import { StrategyDashboard } from "../../features/trading/components/StrategyDashboard";
import { useTradingStatus } from "../../shared/lib/trading";

/**
 * チャートと、稼働中の戦略のカード。カードを押すとチャートの印をその戦略に切り替える。
 * 以前のホームのタブの URL（?strategy= は戦略の id、統合前の ?run= は口座の id）は戦略の画面へ移す
 */
export function HomePage() {
	const [params] = useSearchParams();
	const { runs } = useTradingStatus();
	const { summaries, error } = useStrategySummaries();
	const [chosen, setChosen] = useMarkTarget();
	const strategyParam = params.get("strategy");
	const runParam = params.get("run");
	if ((strategyParam !== null || runParam !== null) && runs !== null) {
		const run =
			strategyParam !== null
				? runs.find((r) => r.id === Number(strategyParam))
				: runs.find((r) => r.accountId === Number(runParam));
		return <Navigate to={run ? `/strategies/${run.id}` : "/home"} replace />;
	}
	const mark = summaries ? markTargetOf(summaries, chosen) : null;
	const markId = mark?.status.id ?? null;
	return (
		<>
			<h1 className="sr-only">ホーム</h1>
			<StrategyDashboard strategyId={markId} layout="home">
				<HomeStrategies
					summaries={summaries}
					error={error}
					runs={runs}
					markId={markId}
					onMark={setChosen}
				/>
			</StrategyDashboard>
		</>
	);
}
