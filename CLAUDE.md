# trading-studio

BTC/JPY の自動売買を、戦略の作成・バックテスト・ペーパー・ライブまで扱うアプリ。

## 開発コマンド

| コマンド | 内容 |
|---|---|
| `bun install` | 依存を入れる |
| `bun run check` | 以下の4つをまとめて実行する（CI と同じ） |
| `bun run lint` | Biome の lint と format の検査。`bun run format` で自動修正 |
| `bun run typecheck` | 型チェック（ルートと各パッケージ） |
| `bun run test` | `bun test` |
| `bun run depcruise` | 依存の向きの検査 |

## パッケージ

- `packages/core`：取引のルール（戦略の型・バックテスト・約定シミュレーション）。外部に依存しない
- `packages/backend`：API と定期処理
- `packages/frontend`：画面

依存の向きは `.dependency-cruiser.cjs` を参照。

## ドキュメント

- docs には実装済みの内容だけを置く。未実装の仕様は GitHub の Issue に置く
- 判断の記録は `docs/adr/`
