import { Link, Navigate, useSearchParams } from "react-router";
import { StrategyList } from "../../features/strategies/components/StrategyList";
import { StrategyDashboard } from "../../features/trading/components/StrategyDashboard";
import { useTradingStatus } from "../../shared/lib/trading";

/**
 * 市場評価とチャートに、戦略の一覧を添える。戦略ごとの状況は戦略の画面で見る。
 * 以前のホームのタブの URL（?strategy= は戦略の id、統合前の ?run= は口座の id）は戦略の画面へ移す
 */
export function HomePage() {
	const [params] = useSearchParams();
	const { runs } = useTradingStatus();
	const strategyParam = params.get("strategy");
	const runParam = params.get("run");
	if ((strategyParam !== null || runParam !== null) && runs !== null) {
		const run =
			strategyParam !== null
				? runs.find((r) => r.id === Number(strategyParam))
				: runs.find((r) => r.accountId === Number(runParam));
		return <Navigate to={run ? `/strategies/${run.id}` : "/home"} replace />;
	}
	return (
		<>
			<h1 className="sr-only">ホーム</h1>
			<StrategyDashboard strategyId={null}>
				{runs?.length === 0 && (
					<div className="flex items-center gap-3 rounded-xl bg-surface p-3.5 text-[13px] lg:col-span-2">
						<span className="flex-1">
							戦略がまだ無い。戦略を作ると、自動取引を動かせる
						</span>
						<Link
							to="/strategies"
							className="shrink-0 font-semibold text-accent underline"
						>
							戦略を作る
						</Link>
					</div>
				)}
				{runs && runs.length > 0 && (
					<section
						aria-label="戦略"
						className="flex flex-col gap-2 lg:col-span-2"
					>
						<h2 className="text-[13px] font-bold">戦略</h2>
						<StrategyList runs={runs} />
					</section>
				)}
			</StrategyDashboard>
		</>
	);
}
