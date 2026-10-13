// テストサイズ（docs/testing.md）ごとに bun test を流す。
// Medium のファイルは先頭に `/** @module-tag medium */` を書く。印の無いファイルは Small
import { Glob } from "bun";

const SIZES = ["small", "medium"] as const;
type Size = (typeof SIZES)[number];

// node_modules を走査しないよう、テストの置き場所に絞る
const TEST_FILES = [
	"packages/*/src/**/*.test.{ts,tsx}",
	"scripts/**/*.test.{ts,tsx}",
];

// ファイル先頭のコメント（JSDoc 形式）に書かれた @module-tag を読む
const LEADING_COMMENT = /^\s*\/\*\*([\s\S]*?)\*\//;
const MODULE_TAG = /@module-tag\s+(\S+)/g;

export function sizeOf(source: string): Size {
	const comment = source.match(LEADING_COMMENT)?.[1] ?? "";
	const tags = [...comment.matchAll(MODULE_TAG)].map((m) => m[1]);
	for (const tag of tags) {
		if (!SIZES.includes(tag as Size)) {
			throw new Error(`未知の @module-tag: ${tag}`);
		}
	}
	return tags.includes("medium") ? "medium" : "small";
}

async function main() {
	const size = process.argv[2];
	if (!SIZES.includes(size as Size)) {
		console.error(`使い方: bun scripts/test-size.ts <${SIZES.join("|")}>`);
		process.exit(2);
	}
	const files: string[] = [];
	for (const pattern of TEST_FILES) {
		for await (const path of new Glob(pattern).scan()) {
			try {
				if (sizeOf(await Bun.file(path).text()) === size) {
					files.push(`./${path}`);
				}
			} catch (e) {
				console.error(`${path}: ${(e as Error).message}`);
				process.exit(2);
			}
		}
	}
	if (files.length === 0) {
		console.log(`${size} のテストファイルはありません`);
		return;
	}
	const proc = Bun.spawn(["bun", "test", ...files.sort()], {
		stdio: ["inherit", "inherit", "inherit"],
	});
	process.exit(await proc.exited);
}

if (import.meta.main) await main();
