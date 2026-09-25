# trading-studio

BTC/JPY の自動売買を、戦略の作成・バックテスト・ペーパー・ライブまで扱うアプリ。

## 開発

[Bun](https://bun.sh/) を使う。版は `package.json` の `packageManager` に合わせる。

```sh
bun install
bun run check   # lint・型チェック・テスト・依存の検査
```

コマンドの一覧とパッケージの役割は [CLAUDE.md](CLAUDE.md) を参照。
