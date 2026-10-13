---
paths:
  - "packages/frontend/**"
---

# frontend の決まり事

- 画面はスマホ幅を前提に作る

## 構成

`src/` は Bulletproof React を基に3つに分ける（`docs/adr/0028-test-scope-and-layers.md`）。

| フォルダ | 置くもの |
|---|---|
| `app/` | 起動（`main.tsx`）、画面の切り替え（`App.tsx`）、API の接続（`ApiProvider.tsx`）、各画面（`routes/`） |
| `features/<機能>/` | 1つの機能だけで使うもの。機能は `trading`（ホームの運用）・`backtest`・`news`（ニュース・市場評価・評価の分析）・`market-data`（インポート・エクスポート・相場データ）・`settings`。中は `components/`・`utils/` を必要な分だけ置く |
| `shared/` | 複数の機能で使うもの。`components/`（画面の部品）と `lib/`（API クライアント・書式・数値など） |

- 依存は `shared → features → app` の一方向。機能どうしは参照しない。`.dependency-cruiser.cjs` で検査する
- 2つ以上の機能から使うものは `shared/` に置く。機能どうしの参照が必要になったら、その部品を `shared/` へ移す
- 1つの機能でしか使わないものは、その機能に置く。戦略の画面は固有の部品がまだ無いので `features/strategies/` が無い。足すときに作る
