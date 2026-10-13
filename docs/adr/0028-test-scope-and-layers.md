# 0028. テストのスコープを層をまたぐかで決め、backend は DDD の3層・frontend は Bulletproof React の構成にする

- ステータス: 採用（ユーザーと議論して決定: 2026-10-13。実装は Issue #198 の子 Issue で順に進める）
- 日付: 2026-10-13

## コンテキスト

ユニット・インテグレーション・E2E の呼び方が人によってずれていた。DB を通るか・API を通るかで分ける読み方もあれば、層をまたぐかで分ける読み方もある。スコープを決めるには、その前提になる層の構成も決める必要がある。今の構成（`routes/`・`service.ts`・`repository.ts` など）に縛られず、理想の構成として決める（利用者）。呼び名は出典（一次資料）で裏付ける。

この ADR は Issue #198 の決定事項を、レビュー役（`.claude/agents/rule-reviewer.md`）が判断の根拠として読めるように残すもの。決定のうち実装済みの範囲は `docs/testing.md` と `.claude/rules/` に書く。

## 決定

### 層（呼び名は DDD に揃える）

backend は Microsoft の DDD ガイドの3層にする。

| 層 | 置くもの |
|---|---|
| アプリケーション層 | 起動（`main.ts`・`app.ts`）、API の入口、MCP、常駐処理のタイマー。業務ルールを持たない薄い層 |
| ドメイン層 | core（取引のルール）と業務の手順（今の各 `service.ts`）。リポジトリの型（インターフェース）もここ |
| インフラ層 | リポジトリの実装、DB、外部 API への接続、外部接続の偽物 |

- 機能ごとのフォルダに `<名前>-<層>.ts`（層は `app`・`domain`・`infra`、ハイフン区切り）で並べる。テストはその後に `.test.ts`
- `src/` 直下は起動まわり（`main.ts`・`app.ts`）だけで、アプリケーション層に属する
- 機能フォルダの中のファイル名の末尾と、依存の向き（ドメインはアプリケーション層・インフラ層に依存しない。インフラはドメインに依存し、アプリケーション層には依存しない）は dependency-cruiser で接尾辞から強制する
- 常駐処理（ニュースの採点・収集、価格の収集）は、タイマー（app）・1回分の手順（domain）・外部呼び出し（infra）に分ける
- アプリケーション層から core を直接呼ぶのは設計違反

frontend は Bulletproof React を基に `app/`・`features/`・`shared/` にする。

- 依存は `shared → features → app` の一方向。機能どうしは参照しない。dependency-cruiser でフォルダ名から強制する
- 複数の機能で使うもの（チャート、市場評価のバッジ）は `shared/`
- frontend から見た core は外部の計算ライブラリとして扱う

### スコープ

層をまたぐかどうかで分ける。DB や API を通るかは定義に入れない。

| スコープ | 定義 |
|---|---|
| ユニット | 入口が関数・クラス・部品の1つで、層をまたがない。内部で別の関数を使っていてもよい |
| インテグレーション | 2つ以上の層をまたいで確かめる。frontend ではページを API だけ偽物にして確かめるもの（Testing Trophy） |
| E2E | backend と frontend をつなぎ、利用者の操作から確かめる。外部サービスは偽物でよい |

- 副作用のないドメインの計算（core）を呼ぶだけなら、層をまたいだとみなさない

### 差し替え（モック）の基準

- 差し替えは層の境界で行う: リポジトリ、API 通信、外部サービス、現在時刻
- 同じ層の内部の関数は差し替えないのを推奨（壊れにくいなら可）
- 確かめるのは結果だけ（戻り値・表示・保存された内容）。呼ばれた回数や引数は確かめない。呼ぶこと自体が振る舞いのとき（注文を送るなど）は例外
- frontend の偽物の API の応答には backend の型を付け、本物との食い違いを型チェックで検出する

### E2E は CUJ だけ

E2E は CUJ（利用者体験の中核になる一連の操作）の主な流れだけを確かめる。細かいケースは下の層で確かめる。

1. 戦略を作り、バックテストを流し、結果を見る
2. デモ運用を始め、ホームで状況を見て、止める
3. リアル運用を始めて止める（取引所は偽物）。リアル取引の実装時に追加する

ニュース・市場評価は CUJ に含めない。

### テストの置き場所とサイズ

- ユニットは対象の隣に同じ名前で置く
- インテグレーションは `packages/backend/integration/` と `packages/frontend/integration/`（単数形）
- E2E は `packages/e2e/`。独立したワークスペースにし、Playwright とその設定もここへ移す
- サイズ（Small・Medium）は、Medium のファイルの先頭に `/** @module-tag medium */` と書いて表す（印が無ければ Small）。小さなスクリプトが印のあるファイルを集めて `bun test` に渡す。書き方は Vitest 4.1 のタグ機能に合わせる。E2E はすべて Medium なので印を付けない

### 進め方

- 実装は子 Issue ごとに進め、ユーザーのレビューは挟まない
- 代わりに、PR を作る前にレビュー役（`.claude/agents/rule-reviewer.md`）のレビューを通す

## 結果

- スコープの判断が層の構成から一意に決まる。DB を使うかどうかで呼び名が変わらない
- 層の接尾辞を検査で強制するので、置き場所の誤りは CI で落ちる。業務ルールをアプリケーション層に書く・同じ層の内部を差し替える、といった検査で捉えられないものはレビュー役が見る
- 既存のファイルの移行が大きい。移行の途中は、決定の形のファイルと旧い形のファイルが並ぶ。新しく作るファイルから決定の形にする
- E2E の多くはインテグレーションへ移る。E2E で拾えていた画面と API のつなぎ目の食い違いは、偽物の応答に backend の型を付けて型チェックで拾う
- サイズの印をファイル名からファイル先頭の注釈に変えるので、`docs/testing.md` の現在の書き方（`*.medium.test.ts`）は移行の PR で置き換える

## 検討した代替案

- DB や API を通るかでスコープを分ける: DB は技術要素の1つにすぎず、同じテストでも使う道具次第で呼び名が変わる
- 一番上を層で切る backend 構成: 1つの機能のファイルが3か所に散る
- `trading.domain.ts` / `TradingDomain.ts`: ドットが重なり冗長 / 大文字始まりは frontend の画面部品の印になっている
- ファイル名でのサイズの印（`.medium.test.ts`）: 層の接尾辞と重なり名前が長い
- Vitest への移行: backend が `bun:sqlite` を使い Node.js 上で動かない
- E2E を全機能に広げる: 遅く壊れやすい。中核の流れを最小本数にする（The Practical Test Pyramid）

参考: [Microsoft の DDD ガイド](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/ddd-oriented-microservice) / [Bulletproof React](https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md) / [Testing Trophy and Testing Classifications](https://kentcdodds.com/blog/testing-trophy-and-testing-classifications) / [Implementing SLOs](https://sre.google/workbook/implementing-slos/) / [The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html) / [PresentationDomainDataLayering](https://martinfowler.com/bliki/PresentationDomainDataLayering.html) / [Vitest の Test Tags](https://vitest.dev/guide/test-tags)
