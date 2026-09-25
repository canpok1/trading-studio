/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
	forbidden: [
		{
			name: "core-not-to-app",
			comment: "core を外部から独立させる",
			severity: "error",
			from: { path: "^packages/core/" },
			to: { path: "^packages/(backend|frontend)/" },
		},
		{
			name: "core-not-to-runtime",
			comment:
				"ファイル・DB へのアクセスを core に持ち込ませない。node:* も bun:* もここに当たる。テストは bun:test を使うため除く",
			severity: "error",
			from: { path: "^packages/core/", pathNot: "\\.test\\.tsx?$" },
			to: { dependencyTypes: ["core"] },
		},
		{
			name: "frontend-to-backend-type-only",
			comment:
				"Hono RPC で API の型だけを共有する。`import { type A }` の形は型だけの扱いになるため、biome.json の useImportType で `import type` に揃える",
			severity: "error",
			from: { path: "^packages/frontend/" },
			to: {
				path: "^packages/backend/",
				dependencyTypesNot: ["type-only"],
			},
		},
		{
			name: "backend-not-to-frontend",
			comment: "backend は画面のビルド成果物をファイルとして配信するだけ",
			severity: "error",
			from: { path: "^packages/backend/" },
			to: { path: "^packages/frontend/" },
		},
		{
			name: "no-circular",
			comment: "変更の影響範囲を追えなくなるため",
			severity: "error",
			from: {},
			to: { circular: true },
		},
		{
			name: "not-to-unresolvable",
			comment: "解決できない import は検査をすり抜けるため禁止する",
			severity: "error",
			from: {},
			to: { couldNotResolve: true },
		},
	],
	options: {
		doNotFollow: { path: "node_modules" },
		exclude: { path: "node_modules" },
		tsPreCompilationDeps: true,
		tsConfig: { fileName: "tsconfig.json" },
		enhancedResolveOptions: {
			exportsFields: ["exports"],
			conditionNames: ["import", "require", "node", "default", "types"],
		},
	},
};
