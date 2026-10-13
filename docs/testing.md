# テストサイズ

自動テストを、実行に要る環境の広さで Small・Medium・Large に分ける（Google のテストサイズ）。まとめて流す単位を選ぶのに使う。

| サイズ | 収まる範囲 | 使ってよいもの | このリポジトリでの該当 | 流し方 |
|---|---|---|---|---|
| Small | 1プロセス | メモリ上だけ。ファイル・ネットワーク・別プロセスは使わない。メモリ上の SQLite（`createTestDb`）は可 | `*.test.ts(x)` のうち下記以外 | `bun run test:small` |
| Medium | 1マシン | 一時ファイル、localhost のサーバー、ブラウザ | 先頭に `/** @module-tag medium */` と書いた `*.test.ts(x)`、画面の配置のテスト（`packages/frontend/integration/*.pw.ts`）、E2E（`packages/e2e/src/*.e2e.ts`） | `bun run test:medium`、`bun run test:browser`、`bun run test:e2e` |
| Large | 複数マシン | 本物の外部サービス（Coincheck・Gemini など） | なし | — |

- サイズはファイル単位で決め、Medium のファイルだけ先頭に `/** @module-tag medium */` と書く（Vitest 4.1 の[タグ](https://vitest.dev/guide/test-tags)の書き方）。印の無い `*.test.ts(x)` は Small とみなす
- `test:small` と `test:medium` は `scripts/test-size.ts` が印を読んでファイルを分け、`bun test` に渡す。`small`・`medium` 以外の印はエラーになる
- 1つのファイルに Small と Medium が混ざるなら、Medium の部分を別ファイルに分ける
- Playwright で流すもの（`*.pw.ts`・E2E）はすべて Medium なので印を付けない
- `bun run test`（CI の `check`）は Small と Medium の両方を流す

# 画面のインテグレーション

`packages/frontend/integration/` に置く。ページを API だけ偽物にして確かめる（`docs/adr/0028-test-scope-and-layers.md`）。

| 確かめる内容 | 書き方 | 流し方 |
|---|---|---|
| 画面の振る舞い（入力の検証、絞り込み、表示の切り替え、画面の移動） | `*.test.tsx`。`render-app.tsx` の `renderApp` で画面全体を happy-dom の上に描き、Testing Library で操作する | `bun run test` |
| 見た目の配置（スマホと PC で見える項目、横にはみ出さない、並び順） | `*.pw.ts`。`browser.ts` の `test` を使い、ビルド済みの画面を実ブラウザで開く | `bun run test:browser` |

- happy-dom のテストは先頭で `setupDom()`（`src/shared/lib/test-setup.ts`）を呼ぶ。DOM をそのファイルの間だけ用意する
- テキスト・日付・数値の入力欄へは `changeValue`（同じファイル）で値を入れる。`fireEvent.change` では React の `onChange` が呼ばれない（選択肢・チェックボックス・ファイルは `fireEvent` でよい）
- 偽物の API は `fake-api.ts` の `FakeApi`。`on(routes.api.version, "$get", () => ({ … }))` のように口を指定し、応答は backend の型で検査される。状態コードを決めるときはハンドラーの2つ目の引数 `reply(409, { … })` で返す。本文はその状態コードで backend が返す型で検査される。`Response` を直に返すのはファイルなど JSON でない応答だけ（型が効かないため）
- `createFakeApi()` はどの画面でも読み込む口（自動取引の状況・実行中のバックテスト・バージョン）を空で答える。画面ごとに要る口はテストで足す。登録の無い口は 404 を返し、`FakeApi.unhandled` に残る
- 応答のひな形は `fixtures.ts`。変えたいところだけ上書きする
- 送った内容を確かめるのは、送ること自体が振る舞いのとき（保存など）だけ。`FakeApi.requests` で見る

# E2E

`packages/e2e/` を独立したワークスペースにし、Playwright とその設定（`playwright.config.ts`）もここに置く。`bun run test:e2e` で流す。

E2E は CUJ（利用者体験の中核になる一連の操作）の主な流れだけを確かめる（`docs/adr/0028-test-scope-and-layers.md`）。CUJ のテストはファイル名を `cuj-*.e2e.ts` にする。

| CUJ | ファイル |
|---|---|
| 戦略を作り、バックテストを流し、結果を見る | `cuj-backtest.e2e.ts` |
| デモ運用を始め、ホームで状況を見て、止める | `cuj-demo.e2e.ts` |

- 画面の操作で確かめるのは CUJ の流れの部分だけ。前提の用意（過去データの取り込み、画面のひな形に無い条件）は API で行う
- CUJ 以外の `*.e2e.ts` は移行前のもの。インテグレーションへ移した PR で消す
