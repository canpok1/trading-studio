# Claude Code からの接続（MCP）

ローカルの Claude Code から戦略を相談して改良するための MCP サーバー。backend の `/mcp`（Streamable HTTP、セッションを持たない）で動く。

## つなぎ方

Tailscale に接続した PC で、一度だけ次を実行する。`<サーバー>` は画面を開くときのアドレス（`<mini-pc のマシン名>.<tailnet 名>.ts.net`）。

```bash
claude mcp add --transport http trading-studio https://<サーバー>/mcp
```

認証は付けない。画面と同じく tailnet 内の端末からだけ届く（`docs/adr/0004`）。

## 道具

| 道具 | 内容 |
|---|---|
| `get_guide` | 条件セット（戦略の params）の項目・単位・範囲とひな形の例 |
| `list_strategies` `get_strategy` | 戦略の一覧・1件。条件は画面の文言と JSON の両方で返す。運用する戦略には `active` が付く |
| `create_strategy` | 条件セットから新しい戦略を保存する |
| `update_strategy` | 戦略の条件を置き換える。運用する戦略は変えられない |
| `get_data_coverage` | 価格データの粒度ごとの範囲と欠損の数 |
| `run_backtest` | 戦略か条件セットでバックテストを実行し、終わるまで（最大 2 分）待って成績を返す。待ちきれなければ実行中のまま返す |
| `list_backtests` `get_backtest` `get_backtest_orders` | バックテストの一覧・1件の条件と成績・注文（発注の理由と往復の損益を含む） |

- 自動取引のオン/オフ・リセット、運用する戦略の切替、運用する戦略の変更、削除、API キーや設定の変更は道具にしない。口座や実資金に効く操作は画面から人が行う（`docs/adr/0012`）
- 入力の検証は画面と同じ（戦略の名前・条件セット・バックテストの実行条件）
- 時刻は JST の ISO 8601 で返す。入力はタイムゾーン付きの ISO 8601 か `YYYY-MM-DD`（JST の 0:00）
