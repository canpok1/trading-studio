---
paths:
  - "packages/backend/**"
---

# backend の決まり事

- 取引のルールは `core` に置き、backend は DB・外部 API・定期処理との橋渡しに留める

## 層の構成（docs/adr/0028-test-scope-and-layers.md）

`src/` の下を機能ごとのフォルダに分け、ファイル名の末尾で層を表す（`<名前>-<層>.ts`）。

| 末尾 | 層 | 置くもの |
|---|---|---|
| `-app` | アプリケーション層 | API の入口。業務ルールを持たない |
| `-domain` | ドメイン層 | 業務の手順（`<機能>-domain.ts`）、API と画面が使う型（`types-domain.ts`）、リポジトリの型（`repository-domain.ts`） |
| `-infra` | インフラ層 | リポジトリの実装、DB、外部 API への接続、外部接続の偽物 |

- `src/` 直下は起動まわり（`main.ts`・`app.ts`・`index.ts`）だけ。アプリケーション層に属する
- テストは対象の後ろに `.test.ts`（`market-domain.test.ts`）。層をまたぐテストは `packages/backend/integration/` に置く
- ドメインは他の機能のインフラを型でも参照しない。他の機能のリポジトリを使うときは、その機能の `repository-domain.ts` の型を `Pick` で受ける（型が無い機能なら、使うものだけを自分の `repository-domain.ts` に書く）。実装は `main.ts` で渡す
- リポジトリだけが使う行の型は `repository-domain.ts` に置き、`types-domain.ts` には API と画面が使う型だけを置く
- 常駐処理は、タイマー（`main.ts` の `setInterval`）・1回分の手順と次の時刻の判断（`-domain` の `tick`・`run`）・外部呼び出し（`-infra`。HTTP・RSS・AI のモデル）に分ける。外部呼び出しは `main.ts` でドメインへ渡す
- 機能をまたいで使うものは、その機能の `-domain.ts` に置く（AI のモデルの型と選べるモデルは `ai/model-domain.ts`）
- アプリケーション層は core を直接呼ばない（型だけの import は可）。core の関数や業務の決まり（足の粒度・条件セット・期間の上限など）を使う入力の検査はドメインの関数（`parse…`）にし、入口は結果を応答に変えるだけにする。JSON の形（`typeof`・整数か）の確認と、一覧の件数の既定値・上限のような API の都合は入口に置いてよい。core の関数を `-domain.ts` から素通しで export して回避しない
- 検査: 末尾の有無は `bun run layers`、依存の向き（ドメイン → アプリケーション・インフラ、インフラ → アプリケーション、アプリケーション → core）は `bun run depcruise`
