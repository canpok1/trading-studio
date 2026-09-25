import { migrateDb } from "./migrate";
import type { Db } from "./open";
import { openDb } from "./open";

// テスト用。ファイルを作らず、マイグレーションを適用済みの DB を返す
export function createTestDb(): Db {
	const db = openDb(":memory:");
	migrateDb(db, { now: 0 });
	return db;
}
