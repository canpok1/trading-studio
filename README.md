# trading-studio

BTC/JPY の自動売買を、戦略の作成・バックテスト・ペーパー・ライブまで扱うアプリ。

## 開発

[Bun](https://bun.sh/) を使う。版は `package.json` の `packageManager` に合わせる。

```sh
bun install
bun run check   # lint・型チェック・テスト・依存の検査
bun run dev     # 開発サーバー（画面は http://127.0.0.1:5173）
bun run build && bun run start   # 本番と同じ1プロセスで起動（http://127.0.0.1:3000）
```

待ち受け先は環境変数 `HOST`・`PORT`（backend）で変える。既定は `127.0.0.1:3000`。`HOST=0.0.0.0` にすると別の端末から開ける。開発サーバーの画面も `HOST` に従う。

コマンドの一覧とパッケージの役割は [CLAUDE.md](CLAUDE.md) を参照。
