import { defineConfig, devices } from "@playwright/test";

// 見た目の配置のインテグレーション。ビルド済みの画面を vite preview で配り、API は偽物にする（先に bun run build が要る。bun run test:browser が行う）
const port = Number(process.env.BROWSER_TEST_PORT ?? 4173);

export default defineConfig({
	testDir: "integration",
	// bun test に拾われないよう *.pw.ts にする
	testMatch: "**/*.pw.ts",
	forbidOnly: !!process.env.CI,
	retries: 0,
	reporter: process.env.CI ? "github" : "list",
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		trace: "retain-on-failure",
		// Playwright の版と合わない Chromium しか無い環境（Claude Code on the web など）では、パスを指定して使う
		launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
			? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
			: {},
	},
	projects: [
		{
			name: "mobile",
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 390, height: 844 },
				isMobile: true,
				hasTouch: true,
			},
		},
		{
			name: "desktop",
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1280, height: 800 },
			},
		},
	],
	webServer: {
		command: `vite preview --host 127.0.0.1 --port ${port} --strictPort`,
		url: `http://127.0.0.1:${port}`,
		reuseExistingServer: false,
	},
});
