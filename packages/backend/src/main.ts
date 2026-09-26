import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { createApp } from "./app";
import { migrateDb } from "./db/migrate";
import { isDbReachable, openDb } from "./db/open";
import { MarketDataRepository } from "./market-data/repository";
import { createMarketDataService } from "./market-data/service";
import { serveFrontend } from "./static";
import { createStrategyService } from "./strategies/service";

const hostname = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const distDir =
	process.env.STATIC_DIR ??
	fileURLToPath(new URL("../../frontend/dist", import.meta.url));
// 既定はリポジトリ直下の data/。bun run --filter は各パッケージを作業ディレクトリにして動くため、作業ディレクトリ基準にしない
const dbPath =
	process.env.DB_PATH ??
	fileURLToPath(new URL("../../../data/trading-studio.db", import.meta.url));

const db = openDb(dbPath);
try {
	const { applied, backupPath } = migrateDb(db, {
		backupDir: join(dirname(dbPath), "backup"),
		now: Date.now(),
	});
	if (applied > 0) {
		console.log(
			`migrated ${applied} file(s)${backupPath ? `, backup: ${backupPath}` : ""}`,
		);
	}
} catch (e) {
	// DB が中途半端な状態のまま動かさない
	console.error("migration failed", e);
	process.exit(1);
}

const marketDataRepo = new MarketDataRepository(db);
marketDataRepo.failInterrupted(Date.now());

const server = new Hono().route(
	"/",
	createApp({
		isDbReachable: () => isDbReachable(db),
		marketData: createMarketDataService(marketDataRepo),
		strategies: createStrategyService(db),
	}),
);
serveFrontend(server, distDir);

const http = Bun.serve({ hostname, port, fetch: server.fetch });
console.log(`listening on http://${hostname}:${port}, db: ${dbPath}`);

// コンテナでは PID 1 になり、ハンドラが無いと SIGTERM が無視されて入れ替えのたびに強制終了を待つことになる
for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, async () => {
		await http.stop();
		db.$client.close();
		process.exit(0);
	});
}
