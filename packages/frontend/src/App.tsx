import { Navigate, Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { DataPage } from "./pages/DataPage";
import { OtherPage } from "./pages/OtherPage";
import { Placeholder } from "./pages/Placeholder";
import { SettingsPage } from "./pages/SettingsPage";

export function App() {
	return (
		<Routes>
			<Route element={<Layout />}>
				<Route index element={<Navigate to="/backtest" replace />} />
				<Route
					path="/backtest"
					element={<Placeholder title="バックテスト" />}
				/>
				<Route path="/strategies" element={<Placeholder title="戦略設定" />} />
				<Route path="/data" element={<DataPage />} />
				<Route path="/other" element={<OtherPage />} />
				<Route path="/settings" element={<SettingsPage />} />
				<Route path="*" element={<Navigate to="/backtest" replace />} />
			</Route>
		</Routes>
	);
}
