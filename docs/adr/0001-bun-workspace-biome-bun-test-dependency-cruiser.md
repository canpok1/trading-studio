# 0001. 開発基盤に Bun workspace・Biome・bun test・dependency-cruiser を使う

- ステータス: 採用
- 日付: 2026-09-25

## コンテキスト

実行環境は Bun、パッケージは `core`・`backend`・`frontend` の3つと決めている（Issue #1）。`core` は取引のルールを決定論で持つため、ファイル・DB・画面への依存を持ち込ませたくない。これらを人の注意ではなく検査で守れる開発環境が要る。

## 決定

- パッケージ管理は Bun の workspace
- lint と format は Biome、テストは `bun test`
- 依存の向きは dependency-cruiser で検査し、CI で落とす
- TypeScript は 7 系を使う。7.0 には他のツール向けの API が無く dependency-cruiser 18.4 が対応していない（対応は 7.1 の予定）ため、dependency-cruiser は swc（`@swc/core`）で解析する

## 結果

- 設定ファイルと依存が少なく、Bun だけで一通り動く
- `import { type A }` の形は dependency-cruiser が型だけの import とみなすが、実行時にモジュールを読み込み得る。Biome の `useImportType`（`separatedType`）で `import type` の形に揃えて塞ぐ
- `Date.now()` や `fetch` のように import せずに使えるものは防げない。`core` のルールとテストで担保する
- swc の指定は dependency-cruiser の公式ドキュメントで非推奨とされている。7.1 で対応したら tsc の解析に戻す
- 実行のたびに「TypeScript が無い」警告が出る。swc が型だけの import も拾うため実害はない

## 検討した代替案

- ESLint＋Prettier：実績は多いが、設定と依存が増える
- vitest：同上。Bun の実行環境と別に動く
- TypeScript を 6 系に固定：7 系の型チェックの速さを捨てることになる
- Biome だけで検査（`noRestrictedImports`・`noImportCycles`・GritQL の自作ルール）：5つとも検出できたが、import の文字列を照合するだけでパスを解決しない。swc が削除されたときの移行先にする
- oxlint：同じく文字列照合で、linter が Biome と2本立てになる
- ESLint 系（eslint-plugin-boundaries など）：typescript-eslint が TypeScript 7 で動かない
