// 実ブラウザで画面を開き、/api だけ偽物の API で答える
import { test as base } from "@playwright/test";
import type { FakeApi } from "./fake-api";
import { createFakeApi } from "./fake-api";

export const test = base.extend<{ api: FakeApi }>({
	// 本物の backend へは繋がないので、API を使わないテストでも必ず差し替える
	api: [
		async ({ page }, use) => {
			const api = createFakeApi();
			await page.route(
				(url) => url.pathname.startsWith("/api/"),
				async (route) => {
					const req = route.request();
					const res = await api.fetch(req.url(), {
						method: req.method(),
						headers: req.headers(),
						body: req.postData() ?? undefined,
					});
					await route.fulfill({
						status: res.status,
						headers: Object.fromEntries(res.headers),
						body: Buffer.from(await res.arrayBuffer()),
					});
				},
			);
			await use(api);
		},
		{ auto: true },
	],
});

export { expect } from "@playwright/test";
