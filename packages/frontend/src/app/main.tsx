import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { createApiClient } from "../shared/lib/api";
import { initTheme } from "../shared/lib/theme";
import { ApiProvider } from "./ApiProvider";
import { App } from "./App";

initTheme();

const root = document.getElementById("root");
if (!root) {
	throw new Error("#root が見つからない");
}
createRoot(root).render(
	<StrictMode>
		<ApiProvider client={createApiClient()}>
			<BrowserRouter>
				<App />
			</BrowserRouter>
		</ApiProvider>
	</StrictMode>,
);
