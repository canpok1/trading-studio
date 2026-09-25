import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { MIGRATIONS_FOLDER, migrateDb } from "./migrate";
import { isDbReachable, openDb } from "./open";
import { settings } from "./schema";
import { createTestDb } from "./test-db";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "trading-studio-db-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("openDb", () => {
	test("WAL・外部キー制約・ロック待ちを設定する", () => {
		const db = openDb(join(dir, "data", "a.db"));
		const pragma = (name: string) =>
			Object.values(db.$client.query(`PRAGMA ${name}`).get() ?? {})[0];
		expect(pragma("journal_mode")).toBe("wal");
		expect(pragma("foreign_keys")).toBe(1);
		expect(pragma("busy_timeout")).toBe(5000);
		expect(isDbReachable(db)).toBe(true);
		db.$client.close();
		expect(isDbReachable(db)).toBe(false);
	});
});

describe("migrateDb", () => {
	test("DB ファイルが無ければ作って settings テーブルを作る。空の DB はバックアップしない", async () => {
		const backupDir = join(dir, "data", "backup");
		const db = openDb(join(dir, "data", "a.db"));
		const result = migrateDb(db, { backupDir, now: 0 });
		expect(result.applied).toBeGreaterThan(0);
		expect(result.backupPath).toBeUndefined();
		db.insert(settings).values({ key: "k", value: "v" }).run();
		expect(db.select().from(settings).all()).toEqual([
			{ key: "k", value: "v" },
		]);
		expect(await readdir(join(dir, "data"))).toContain("a.db");
	});

	test("適用済みなら何もしない", () => {
		const backupDir = join(dir, "backup");
		const db = openDb(join(dir, "a.db"));
		migrateDb(db, { backupDir, now: 0 });
		expect(migrateDb(db, { backupDir, now: 1 })).toEqual({ applied: 0 });
	});

	test("未適用があれば、適用前の DB をバックアップしてから適用する", async () => {
		const backupDir = join(dir, "backup");
		const db = openDb(join(dir, "a.db"));
		migrateDb(db, { backupDir, now: 0 });
		db.insert(settings).values({ key: "before", value: "1" }).run();

		const folder = await addMigration(
			"CREATE TABLE `extra` (`id` integer PRIMARY KEY NOT NULL);",
		);
		const result = migrateDb(db, {
			migrationsFolder: folder,
			backupDir,
			now: Date.UTC(2026, 8, 25, 14, 30),
		});

		expect(result.applied).toBe(1);
		expect(result.backupPath).toBe(join(backupDir, "20260925T143000000Z.db"));
		const backup = openDb(result.backupPath as string);
		expect(
			backup.select().from(settings).where(eq(settings.key, "before")).all(),
		).toHaveLength(1);
		const tables = (d: typeof db) =>
			d.$client
				.query<{ name: string }, []>(
					"select name from sqlite_master where type = 'table'",
				)
				.all()
				.map((r) => r.name);
		expect(tables(backup)).not.toContain("extra");
		expect(tables(db)).toContain("extra");
	});

	test("適用に失敗したら例外を投げ、DB を元のままにする", async () => {
		const db = openDb(join(dir, "a.db"));
		migrateDb(db, { now: 0 });
		const folder = await addMigration(
			"CREATE TABLE `ok_table` (`id` integer);\n--> statement-breakpoint\nTHIS IS NOT SQL;",
		);
		expect(() => migrateDb(db, { migrationsFolder: folder, now: 1 })).toThrow();
		expect(
			db.$client
				.query("select name from sqlite_master where name = 'ok_table'")
				.get(),
		).toBeNull();
	});
});

describe("createTestDb", () => {
	test("ファイルを作らずにマイグレーション済みの DB を返す", () => {
		const db = createTestDb();
		db.insert(settings).values({ key: "k", value: "v" }).run();
		expect(db.select().from(settings).all()).toHaveLength(1);
	});
});

// 既存のマイグレーションに1件足したフォルダを作る
async function addMigration(sql: string): Promise<string> {
	const folder = join(dir, "migrations");
	await cp(MIGRATIONS_FOLDER, folder, { recursive: true });
	const journalPath = join(folder, "meta", "_journal.json");
	const journal = await Bun.file(journalPath).json();
	const tag = "9999_extra";
	const last = journal.entries.at(-1);
	journal.entries.push({
		idx: journal.entries.length,
		version: last.version,
		when: last.when + 1,
		tag,
		breakpoints: true,
	});
	await writeFile(journalPath, JSON.stringify(journal));
	await writeFile(join(folder, `${tag}.sql`), sql);
	return folder;
}
