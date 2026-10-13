---
paths:
  - "packages/backend/**"
---

# backend の決まり事

- 取引のルールは `core` に置き、backend は DB・外部 API・定期処理との橋渡しに留める

## 層の構成（docs/adr/0028-test-scope-and-layers.md）

`src/` の下を機能ごとのフォルダに分け、ファイル名の末尾で層を表す（`<名前>-<層>.ts`）。移し終えていない機能は `scripts/check-backend-layers.ts` の `NOT_MIGRATED` にあり、検査から外れている。

| 末尾 | 層 | 置くもの |
|---|---|---|
| `-app` | アプリケーション層 | API の入口。業務ルールを持たない |
| `-domain` | ドメイン層 | 業務の手順（`<機能>-domain.ts`）、API と画面が使う型（`types-domain.ts`）、リポジトリの型（`repository-domain.ts`） |
| `-infra` | インフラ層 | リポジトリの実装、DB、外部 API への接続、外部接続の偽物 |

- `src/` 直下は起動まわり（`main.ts`・`app.ts`・`index.ts`）だけ。アプリケーション層に属する
- テストは対象の後ろに `.test.ts`（`market-domain.test.ts`）。層をまたぐテストは `packages/backend/integration/` に置く
- ドメインは他の機能のインフラを型でも参照しない。使うものだけをリポジトリの型として自分の `repository-domain.ts` に書き、`main.ts` で実装を渡す
- アプリケーション層は core を直接呼ばない（型だけの import は可）。入力の検査（形の確認を含む）はドメインの関数にし、入口は結果を応答に変えるだけにする。core の関数を `-domain.ts` から素通しで export して回避しない
- 検査: 末尾の有無は `bun run layers`、依存の向き（ドメイン → アプリケーション・インフラ、インフラ → アプリケーション、アプリケーション → core）は `bun run depcruise`
