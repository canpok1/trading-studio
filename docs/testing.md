# テストサイズ

自動テストを、実行に要る環境の広さで Small・Medium・Large に分ける（Google のテストサイズ）。まとめて流す単位を選ぶのに使う。

| サイズ | 収まる範囲 | 使ってよいもの | このリポジトリでの該当 | 流し方 |
|---|---|---|---|---|
| Small | 1プロセス | メモリ上だけ。ファイル・ネットワーク・別プロセスは使わない。メモリ上の SQLite（`createTestDb`）は可 | `*.test.ts(x)` のうち下記以外 | `bun run test:small` |
| Medium | 1マシン | 一時ファイル、localhost のサーバー、ブラウザ | 先頭に `/** @module-tag medium */` と書いた `*.test.ts(x)`、E2E（`packages/e2e/src/*.e2e.ts`） | `bun run test:medium`、`bun run test:e2e` |
| Large | 複数マシン | 本物の外部サービス（Coincheck・Gemini など） | なし | — |

- サイズはファイル単位で決め、Medium のファイルだけ先頭に `/** @module-tag medium */` と書く（Vitest 4.1 の[タグ](https://vitest.dev/guide/test-tags)の書き方）。印の無い `*.test.ts(x)` は Small とみなす
- `test:small` と `test:medium` は `scripts/test-size.ts` が印を読んでファイルを分け、`bun test` に渡す。`small`・`medium` 以外の印はエラーになる
- 1つのファイルに Small と Medium が混ざるなら、Medium の部分を別ファイルに分ける
- E2E はすべて Medium なので印を付けない
- `bun run test`（CI の `check`）は Small と Medium の両方を流す

# E2E

`packages/e2e/` を独立したワークスペースにし、Playwright とその設定（`playwright.config.ts`）もここに置く。`bun run test:e2e` で流す。

E2E は CUJ（利用者体験の中核になる一連の操作）の主な流れだけを確かめる（`docs/adr/0028-test-scope-and-layers.md`）。CUJ のテストはファイル名を `cuj-*.e2e.ts` にする。

| CUJ | ファイル |
|---|---|
| 戦略を作り、バックテストを流し、結果を見る | `cuj-backtest.e2e.ts` |
| デモ運用を始め、ホームで状況を見て、止める | `cuj-demo.e2e.ts` |

- 画面の操作で確かめるのは CUJ の流れの部分だけ。前提の用意（過去データの取り込み、画面のひな形に無い条件）は API で行う
- CUJ 以外の `*.e2e.ts` は移行前のもの。インテグレーションへ移した PR で消す
