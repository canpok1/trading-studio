import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { Db } from "./open";

export const MIGRATIONS_FOLDER = fileURLToPath(
	new URL("../../drizzle", import.meta.url),
);

// drizzle の migrate と同じ判定：最後に適用した時刻より新しいものが未適用
function countPending(db: Db, migrationsFolder: string): number {
	const migrations = readMigrationFiles({ migrationsFolder });
	if (!isMigrated(db)) {
		return migrations.length;
	}
	const last = db.$client
		.query<{ created_at: number }, []>(
			"select created_at from __drizzle_migrations order by created_at desc limit 1",
		)
		.get();
	const lastAt = last ? Number(last.created_at) : -1;
	return migrations.filter((m) => m.folderMillis > lastAt).length;
}

export type MigrateOptions = {
	migrationsFolder?: string;
	// 未指定ならバックアップを取らない（メモリ上の DB など）
	backupDir?: string;
	now: number;
};

// 未適用のマイグレーションを適用する。失敗したら例外を投げる。適用はトランザクション内で行われ、失敗時は元に戻る
export function migrateDb(
	db: Db,
	{ migrationsFolder = MIGRATIONS_FOLDER, backupDir, now }: MigrateOptions,
): { applied: number; backupPath?: string } {
	const pending = countPending(db, migrationsFolder);
	if (pending === 0) {
		return { applied: 0 };
	}
	let backupPath: string | undefined;
	// 一度も適用していない DB は空なので、バックアップを取らない
	if (backupDir && isMigrated(db)) {
		mkdirSync(backupDir, { recursive: true });
		backupPath = join(backupDir, `${backupStamp(now)}.db`);
		db.$client.run("VACUUM INTO ?", [backupPath]);
	}
	migrate(db, { migrationsFolder });
	return { applied: pending, backupPath };
}

function isMigrated(db: Db): boolean {
	return (
		db.$client
			.query(
				"select 1 from sqlite_master where type = 'table' and name = '__drizzle_migrations'",
			)
			.get() !== null
	);
}

// 例: 20260925T143000123Z（UTC）
function backupStamp(now: number): string {
	return new Date(now).toISOString().replace(/[-:.]/g, "");
}
