import { migrateDb } from "./migrate-infra";
import type { Db } from "./open-infra";
import { openDb } from "./open-infra";

// テスト用。ファイルを作らず、マイグレーションを適用済みの DB を返す
export function createTestDb(): Db {
	const db = openDb(":memory:");
	migrateDb(db, { now: 0 });
	return db;
}
