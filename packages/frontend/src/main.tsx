import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { ApiProvider, createApiClient } from "./api";
import { initTheme } from "./theme";

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
