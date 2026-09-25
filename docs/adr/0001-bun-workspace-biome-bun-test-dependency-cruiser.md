# 0001. 開発基盤に Bun workspace・Biome・bun test・dependency-cruiser を使う

- ステータス: 採用
- 日付: 2026-09-25

## コンテキスト

実行環境は Bun、パッケージは `core`・`backend`・`frontend` の3つと決めている（Issue #1）。`core` は取引のルールを決定論で持つため、ファイル・DB・画面への依存を持ち込ませたくない。これらを人の注意ではなく検査で守れる開発環境が要る。

## 決定

- パッケージ管理は Bun の workspace
- lint と format は Biome、テストは `bun test`
- 依存の向きは dependency-cruiser で検査し、CI で落とす
- TypeScript は 6 系に固定する。dependency-cruiser 18.4 の対応範囲が `<7.0.0` で、7 系では `import type` の判定に使う TypeScript の API が無いため

## 結果

- 設定ファイルと依存が少なく、Bun だけで一通り動く
- `import { type A }` の形は dependency-cruiser が型だけの import とみなすが、実行時にモジュールを読み込み得る。Biome の `useImportType`（`separatedType`）で `import type` の形に揃えて塞ぐ
- `Date.now()` や `fetch` のように import せずに使えるものは防げない。`core` のルールとテストで担保する
- dependency-cruiser が TypeScript 7 に対応したら固定を外す

## 検討した代替案

- ESLint＋Prettier：実績は多いが、設定と依存が増える
- vitest：同上。Bun の実行環境と別に動く
- Biome の `noRestrictedImports`：モジュール名で禁止できるが、相対パスでのパッケージ越え・循環・型だけの import の区別を扱えない
