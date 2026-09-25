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

DB は SQLite で、既定は `data/trading-studio.db`（環境変数 `DB_PATH` で変える）。起動時に未適用のマイグレーションを適用し、その前に `data/backup/` へバックアップを取る。

コマンドの一覧とパッケージの役割は [CLAUDE.md](CLAUDE.md) を参照。

## デプロイ

main へ push すると、CI がコンテナイメージを GHCR（`ghcr.io/canpok1/trading-studio`）へ `latest` とコミット ID のタグで push する。自宅サーバー（mini-pc）では Watchtower が5分間隔で `latest` を確認し、新しいイメージに入れ替える。mini-pc 側の配置は [canpok1/mini-pc-setup](https://github.com/canpok1/mini-pc-setup) が行う。

手で起動する場合は、`docker-compose.yml` を置いたディレクトリで次を実行する。DB とバックアップは同じディレクトリの `data/` に残り、コンテナを入れ替えても消えない。`data/` は UID/GID `1000:1000` で書き込めるようにしておく。

```sh
docker compose up -d
```

コンテナはホストの `127.0.0.1:3000` にだけ公開する。スマホからは Tailscale Serve で HTTPS 化して開く。

```sh
sudo tailscale serve --bg 3000   # https://<マシン名>.<tailnet 名>.ts.net/ で開ける
```

**cloudflared（Cloudflare Tunnel）経由では公開しない。** インターネットに公開され、ログイン機能の無いこのアプリを誰でも操作できてしまうため。
