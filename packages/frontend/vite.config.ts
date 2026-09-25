import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 開発サーバーも HOST に従う（スマホから開発中の画面を確認するため）。/api は backend へ中継する
const host = process.env.HOST ?? "127.0.0.1";
const backendPort = process.env.PORT ?? "3000";

export default defineConfig({
	plugins: [react()],
	server: {
		host,
		proxy: {
			"/api": `http://127.0.0.1:${backendPort}`,
		},
	},
});
