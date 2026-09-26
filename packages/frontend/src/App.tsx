import { Navigate, Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { DataPage } from "./pages/DataPage";
import { OtherPage } from "./pages/OtherPage";
import { Placeholder } from "./pages/Placeholder";
import { SettingsPage } from "./pages/SettingsPage";
import { StrategiesPage } from "./pages/StrategiesPage";

export function App() {
	return (
		<Routes>
			<Route element={<Layout />}>
				<Route index element={<Navigate to="/backtest" replace />} />
				<Route
					path="/backtest"
					element={<Placeholder title="バックテスト" />}
				/>
				<Route path="/strategies/:id?" element={<StrategiesPage />} />
				<Route path="/data" element={<DataPage />} />
				<Route path="/other" element={<OtherPage />} />
				<Route path="/settings" element={<SettingsPage />} />
				<Route path="*" element={<Navigate to="/backtest" replace />} />
			</Route>
		</Routes>
	);
}
