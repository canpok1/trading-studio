// backend のファイル名が層の構成に沿っているかを検査する（docs/adr/0028-test-scope-and-layers.md）。
// 依存の向きは .dependency-cruiser.cjs が接尾辞から検査する。ここは接尾辞そのものの有無を見る

import { Glob } from "bun";

const SRC = "packages/backend/src";

/** src/ 直下に置いてよいもの（起動まわり。アプリケーション層） */
const ROOT_FILES = new Set(["main.ts", "app.ts", "index.ts"]);

/**
 * まだ層の構成へ移していないもの（src/ からの相対パス。末尾 / はフォルダ）。
 * Issue #201 で機能ごとに移し、移したらここから外す
 */
export const NOT_MIGRATED = [
	"advice/",
	"ai/",
	"analysis-export/",
	"backtests/",
	"collector/",
	"datasets/",
	"db/",
	"mcp/",
	"news/",
	"routes/",
	"scoring-analysis/",
	"trading/",
	"app.test.ts",
	"slow-log.ts",
	"slow-log.test.ts",
	"static.ts",
	"static.test.ts",
	"test-app.ts",
	"version.ts",
	"version.test.ts",
];

const LAYERED = /-(app|domain|infra)(\.test)?\.ts$/;

/** 構成に沿わないファイルの、src/ からの相対パス */
export function layerViolations(
	paths: readonly string[],
	notMigrated: readonly string[] = NOT_MIGRATED,
): string[] {
	return paths.filter((p) => {
		if (notMigrated.some((n) => (n.endsWith("/") ? p.startsWith(n) : p === n)))
			return false;
		if (!p.includes("/")) return !ROOT_FILES.has(p);
		const name = p.slice(p.lastIndexOf("/") + 1);
		return !LAYERED.test(name);
	});
}

/** 除外の一覧のうち、もう当てはまるファイルが無いもの（移し終えたのに外し忘れたもの） */
export function staleExclusions(
	paths: readonly string[],
	notMigrated: readonly string[] = NOT_MIGRATED,
): string[] {
	return notMigrated.filter(
		(n) => !paths.some((p) => (n.endsWith("/") ? p.startsWith(n) : p === n)),
	);
}

if (import.meta.main) {
	const paths = [...new Glob("**/*").scanSync({ cwd: SRC })].sort();
	const bad = layerViolations(paths);
	const stale = staleExclusions(paths);
	if (stale.length > 0) {
		console.error(
			`scripts/check-backend-layers.ts の NOT_MIGRATED に、もう無いものがある。外す: ${stale.join(" ")}`,
		);
	}
	if (bad.length > 0) {
		console.error(
			[
				"backend のファイル名が層の構成に沿っていない（docs/adr/0028-test-scope-and-layers.md）。",
				`- ${SRC}/ 直下は ${[...ROOT_FILES].join("・")} だけ`,
				"- 機能フォルダの中は末尾を -app・-domain・-infra にする（テストはその後に .test.ts）",
				...bad.map((p) => `  ${SRC}/${p}`),
			].join("\n"),
		);
	}
	if (stale.length > 0 || bad.length > 0) process.exit(1);
}
