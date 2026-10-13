/** @module-tag medium */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAppBuiltAt } from "./version-infra";

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
