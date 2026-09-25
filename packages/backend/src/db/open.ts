import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

export type Db = BunSQLiteDatabase<typeof schema> & { $client: Database };

// 定期処理と画面操作の書き込みが重なってもエラーにしないよう、ロックを待つ
const BUSY_TIMEOUT_MS = 5000;

export function openDb(path: string): Db {
	if (path !== ":memory:") {
		mkdirSync(dirname(path), { recursive: true });
	}
	const sqlite = new Database(path, { create: true, strict: true });
	sqlite.run("PRAGMA journal_mode = WAL");
	// SQLite は既定で外部キー制約を検査しない
	sqlite.run("PRAGMA foreign_keys = ON");
	sqlite.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
	return drizzle({ client: sqlite, schema });
}

export function isDbReachable(db: Db): boolean {
	try {
		db.$client.query("select 1").get();
		return true;
	} catch {
		return false;
	}
}
