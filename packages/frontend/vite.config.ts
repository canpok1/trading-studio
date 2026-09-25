import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 開発サーバーも HOST に従う（スマホから開発中の画面を確認するため）。/api は同じ HOST・PORT で待ち受ける backend へ中継する
const host = process.env.HOST ?? "127.0.0.1";
const backendPort = process.env.PORT ?? "3000";
// 全アドレスで待ち受けるときは、中継先はループバックで足りる
const backendHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;

export default defineConfig({
	plugins: [react()],
	server: {
		host,
		proxy: {
			"/api": `http://${backendHost.includes(":") ? `[${backendHost}]` : backendHost}:${backendPort}`,
		},
	},
});
