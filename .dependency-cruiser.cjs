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
		// TypeScript 7 には dependency-cruiser が使う API が無いため swc で解析する（docs/adr/0001）。
		// tsPreCompilationDeps を有効にしていると「TypeScript が無い」警告が出るが、swc が型だけの import も拾うので実害はない。
		// swc の指定は公式に非推奨。TypeScript 7.1 で dependency-cruiser が対応したら、parser の行を外して tsc に戻す
		parser: "swc",
		tsPreCompilationDeps: true,
		enhancedResolveOptions: {
			exportsFields: ["exports"],
			conditionNames: ["import", "require", "node", "default", "types"],
		},
	},
};
