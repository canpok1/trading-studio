import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp } from "./test-app";
import { readAppBuiltAt } from "./version";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "trading-studio-version-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("ビルド日時のファイルを読む。無いか数字でなければ開発版（null）", async () => {
	const path = join(dir, "BUILT_AT");
	expect(readAppBuiltAt(path)).toBeNull();
	await writeFile(path, "1790467800000\n");
	expect(readAppBuiltAt(path)).toBe(1790467800000);
	await writeFile(path, "not a number");
	expect(readAppBuiltAt(path)).toBeNull();
});

test("GET /api/version はビルド日時を返す", async () => {
	const { app } = createTestApp({ appBuiltAt: 1790467800000 });
	const res = await app.request("/api/version");
	expect(await res.json()).toEqual({ builtAt: 1790467800000 });
	const dev = createTestApp().app;
	expect(await (await dev.request("/api/version")).json()).toEqual({
		builtAt: null,
	});
});
