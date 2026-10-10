import { useEffect } from "react";
import {
	Navigate,
	Route,
	Routes,
	useLocation,
	useNavigate,
} from "react-router";
import { Layout } from "./components/Layout";
import { Button } from "./components/ui";
import { BacktestJobProvider, useBacktestJob } from "./lib/backtest-job";
import { TradingStatusProvider } from "./lib/trading";
import { BacktestResultPage } from "./pages/BacktestResultPage";
import { BacktestRunPage } from "./pages/BacktestRunPage";
import { DataPage } from "./pages/DataPage";
import { DatasetRunPage } from "./pages/DatasetRunPage";
import { ExportPage } from "./pages/ExportPage";
import { HomePage } from "./pages/HomePage";
import { NewsPage } from "./pages/NewsPage";
import { OtherPage } from "./pages/OtherPage";
import { SettingsPage } from "./pages/SettingsPage";
import { StrategiesPage } from "./pages/StrategiesPage";

export function App() {
	return (
		<BacktestJobProvider>
			<TradingStatusProvider>
				<Shell />
			</TradingStatusProvider>
		</BacktestJobProvider>
	);
}

function Shell() {
	const { running, runningDataset } = useBacktestJob();
	return (
		<>
			<Routes>
				<Route
					element={
						<Layout
							badges={{
								"/backtest": running !== null || runningDataset !== null,
							}}
						/>
					}
				>
					<Route index element={<Navigate to="/home" replace />} />
					<Route path="/home" element={<HomePage />} />
					<Route path="/backtest" element={<BacktestRunPage />} />
					<Route path="/backtest/runs/:id" element={<BacktestResultPage />} />
					<Route
						path="/backtest/dataset-runs/:id"
						element={<DatasetRunPage />}
					/>
					<Route path="/news" element={<NewsPage />} />
					{/* 旧名「AI判定」の URL */}
					<Route path="/ai" element={<Navigate to="/news" replace />} />
					<Route path="/strategies/:id?" element={<StrategiesPage />} />
					{/* 取引画面はホームへ統合した。モードの指定はそのまま渡す */}
					<Route path="/trades" element={<TradesRedirect />} />
					<Route path="/data" element={<DataPage />} />
					<Route path="/export" element={<ExportPage />} />
					<Route path="/other" element={<OtherPage />} />
					<Route path="/settings" element={<SettingsPage />} />
					<Route path="*" element={<Navigate to="/home" replace />} />
				</Route>
			</Routes>
			<FinishedNotice />
		</>
	);
}

function TradesRedirect() {
	const { search } = useLocation();
	return <Navigate to={`/home${search}`} replace />;
}

/** バックテストが終わったら、バックテストの画面にいれば結果へ移り、他の画面にいれば知らせる */
function FinishedNotice() {
	const { finished, finishedDataset, clearFinished } = useBacktestJob();
	const { pathname } = useLocation();
	const navigate = useNavigate();
	const onBacktest =
		pathname === "/backtest" || pathname.startsWith("/backtest/");
	// 失敗・中止は実行画面が表示する
	const to =
		finished?.status === "done"
			? `/backtest/runs/${finished.id}`
			: finishedDataset?.status === "done"
				? `/backtest/dataset-runs/${finishedDataset.id}`
				: null;

	useEffect(() => {
		if (to && onBacktest) {
			clearFinished();
			navigate(to);
		}
	}, [to, onBacktest, navigate, clearFinished]);

	if (!to || onBacktest) return null;
	return (
		<div
			role="status"
			className="fixed inset-x-4 bottom-[calc(80px+env(safe-area-inset-bottom))] z-50 mx-auto flex max-w-[480px] items-center gap-3 rounded-xl bg-text px-4 py-3 text-sm text-bg shadow-xl lg:bottom-6"
		>
			<span className="flex-1">バックテストが終わった</span>
			<Button
				size="sm"
				onClick={() => {
					clearFinished();
					navigate(to);
				}}
			>
				結果を見る
			</Button>
			<button
				type="button"
				aria-label="閉じる"
				onClick={clearFinished}
				className="text-bg/70"
			>
				✕
			</button>
		</div>
	);
}
