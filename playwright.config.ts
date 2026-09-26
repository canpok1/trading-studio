import { defineConfig, devices } from "@playwright/test";

// 画面の E2E。backend をテスト用の DB で起動し、ビルド済みの画面を開く（先に bun run build が要る。bun run test:e2e が行う）
const port = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
	testDir: "e2e",
	// bun test に拾われないよう *.e2e.ts にする
	testMatch: "**/*.e2e.ts",
	fullyParallel: false,
	// DB を共有するので、1つずつ流す
	workers: 1,
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
		command: "bun e2e/server.ts",
		url: `http://127.0.0.1:${port}/api/health`,
		reuseExistingServer: false,
		env: { PORT: String(port) },
	},
});
