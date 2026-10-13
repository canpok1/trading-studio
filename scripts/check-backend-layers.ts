// backend のファイル名が層の構成に沿っているかを検査する（docs/adr/0028-test-scope-and-layers.md）。
// 依存の向きは .dependency-cruiser.cjs が接尾辞から検査する。ここは接尾辞そのものの有無を見る

import { Glob } from "bun";

const SRC = "packages/backend/src";

/** src/ 直下に置いてよいもの（起動まわり。アプリケーション層） */
const ROOT_FILES = new Set(["main.ts", "app.ts", "index.ts"]);

const LAYERED = /-(app|domain|infra)(\.test)?\.ts$/;

/** 構成に沿わないファイルの、src/ からの相対パス */
export function layerViolations(paths: readonly string[]): string[] {
	return paths.filter((p) => {
		if (!p.includes("/")) return !ROOT_FILES.has(p);
		const name = p.slice(p.lastIndexOf("/") + 1);
		return !LAYERED.test(name);
	});
}

if (import.meta.main) {
	const paths = [...new Glob("**/*").scanSync({ cwd: SRC })].sort();
	const bad = layerViolations(paths);
	if (bad.length > 0) {
		console.error(
			[
				"backend のファイル名が層の構成に沿っていない（docs/adr/0028-test-scope-and-layers.md）。",
				`- ${SRC}/ 直下は ${[...ROOT_FILES].join("・")} だけ`,
				"- 機能フォルダの中は末尾を -app・-domain・-infra にする（テストはその後に .test.ts）",
				...bad.map((p) => `  ${SRC}/${p}`),
			].join("\n"),
		);
		process.exit(1);
	}
}
