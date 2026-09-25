import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createApiClient } from "./api";

const root = document.getElementById("root");
if (!root) {
	throw new Error("#root が見つからない");
}
createRoot(root).render(
	<StrictMode>
		<App client={createApiClient()} />
	</StrictMode>,
);
