// happy-dom の上で画面全体を描く。API だけ偽物にする（Testing Trophy のインテグレーション）
import { render } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { ApiProvider } from "../src/app/ApiProvider";
import { App } from "../src/app/App";
import { createApiClient } from "../src/shared/lib/api";
import type { FakeApi } from "./fake-api";
import { createFakeApi } from "./fake-api";

export function renderApp(path: string, api: FakeApi = createFakeApi()) {
	const location = { current: "" };
	function LocationProbe() {
		const l = useLocation();
		location.current = l.pathname + l.search;
		return null;
	}
	const view = render(
		<ApiProvider
			client={createApiClient(
				Object.assign(api.fetch, { preconnect: () => {} }),
			)}
		>
			<MemoryRouter initialEntries={[path]}>
				<App />
				<LocationProbe />
			</MemoryRouter>
		</ApiProvider>,
	);
	return { ...view, api, location };
}
