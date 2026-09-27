import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	cp,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
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

describe("0009 点数の尺度の換算", () => {
	/** 0008 までを適用した DB。0009 の前の状態 */
	async function before0009() {
		const folder = join(dir, "migrations-0008");
		await cp(MIGRATIONS_FOLDER, folder, { recursive: true });
		await rm(join(folder, "0009_score_scale_and_version.sql"));
		const journalPath = join(folder, "meta", "_journal.json");
		const journal = JSON.parse(await readFile(journalPath, "utf8"));
		journal.entries = journal.entries.filter(
			(e: { idx: number }) => e.idx <= 8,
		);
		await writeFile(journalPath, JSON.stringify(journal));
		const db = openDb(join(dir, "a.db"));
		migrateDb(db, { migrationsFolder: folder, now: 0 });
		return db;
	}

	/** NOT NULL の列を仮の値で埋めて1行入れる */
	function insert(
		db: ReturnType<typeof openDb>,
		table: string,
		values: Record<string, unknown>,
	) {
		const cols = db.$client
			.query<{ name: string; notnull: number; pk: number }, []>(
				`pragma table_info(${table})`,
			)
			.all();
		const row: Record<string, unknown> = {};
		for (const c of cols) if (c.notnull && !c.pk) row[c.name] = 0;
		Object.assign(row, values);
		const keys = Object.keys(row);
		db.$client.run(
			`insert into ${table} (${keys.join(", ")}) values (${keys.map(() => "?").join(", ")})`,
			// biome-ignore lint/suspicious/noExplicitAny: テスト用に任意の値を入れる
			Object.values(row) as any[],
		);
	}

	const OLD_RULE = {
		windowHours: 24,
		halfLifeHours: 6,
		thresholds: {
			trend: { up: 60, down: 40 },
			risk: { caution: 40, crisis: 70 },
			sentiment: { plus2: 80, plus1: 60, minus1: 40, minus2: 20 },
		},
	};
	const NEW_RULE = {
		windowHours: 24,
		halfLifeHours: 6,
		thresholds: {
			trend: { up: 20, down: -20 },
			risk: { caution: 40, crisis: 70 },
			sentiment: { plus2: 60, plus1: 20, minus1: -20, minus2: -60 },
		},
	};

	test("トレンドとセンチメントの点数・しきい値を (旧 − 50) × 2 にし、リスクと null はそのまま", async () => {
		const db = await before0009();
		insert(db, "news", { id: 1, url: "https://a.example/1" });
		insert(db, "news", { id: 2, url: "https://a.example/2" });
		insert(db, "news_scores", {
			news_id: 1,
			status: "done",
			trend: 0,
			risk: 30,
			sentiment: 100,
		});
		insert(db, "news_scores", {
			news_id: 2,
			status: "failed",
			trend: null,
			risk: null,
			sentiment: null,
		});
		db.insert(settings)
			.values({ key: "aggregation_rule", value: JSON.stringify(OLD_RULE) })
			.run();
		insert(db, "backtest_runs", {
			id: 1,
			aggregation_rule: JSON.stringify(OLD_RULE),
		});
		insert(db, "backtest_runs", { id: 2, aggregation_rule: null });

		migrateDb(db, { now: 1 });

		expect(
			db.$client
				.query(
					"select news_id, trend, risk, sentiment, app_built_at from news_scores order by news_id",
				)
				.all(),
		).toEqual([
			{ news_id: 1, trend: -100, risk: 30, sentiment: 100, app_built_at: null },
			{
				news_id: 2,
				trend: null,
				risk: null,
				sentiment: null,
				app_built_at: null,
			},
		]);
		const rule = db
			.select()
			.from(settings)
			.where(eq(settings.key, "aggregation_rule"))
			.get();
		expect(JSON.parse(rule?.value ?? "")).toEqual(NEW_RULE);
		const runs = db.$client
			.query<{ aggregation_rule: string | null }, []>(
				"select aggregation_rule from backtest_runs order by id",
			)
			.all();
		expect(JSON.parse(runs[0]?.aggregation_rule ?? "")).toEqual(NEW_RULE);
		expect(runs[1]?.aggregation_rule).toBeNull();
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
