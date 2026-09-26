# Architecture Decision Records (ADR)

重要度の高い判断を記録する。フォーマットは MADR 軽量版（日本語本文）。

| 番号 | タイトル | ステータス | 日付 |
|------|----------|------------|------|
| [0001](0001-bun-workspace-biome-bun-test-dependency-cruiser.md) | 開発基盤に Bun workspace・Biome・bun test・dependency-cruiser を使う | 採用 | 2026-09-25 |
| [0002](0002-sqlite-and-epoch-millis.md) | DB に SQLite を使い、時刻を UTC のエポックミリ秒の整数で持つ | 採用 | 2026-09-25 |
| [0003](0003-deploy-via-ghcr-watchtower-tailscale-serve.md) | GHCR と Watchtower で自宅サーバーへ自動デプロイし、Tailscale Serve で開く | 採用（公開範囲は 0004 で置き換え） | 2026-09-25 |
| [0004](0004-lan-exposure-until-live-trading.md) | 実取引を始めるまでは自宅 LAN 内へ公開し、Tailscale は実取引の前に入れる | 採用 | 2026-09-26 |
| [0005](0005-react-router-and-tailwind.md) | 画面遷移に React Router、CSS に Tailwind CSS v4 を使い、E2E は Playwright で流す | 採用 | 2026-09-26 |
| [0006](0006-backtest-evaluates-on-finer-candles.md) | 判定頻度が足の粒度より短い戦略は、バックテストで細かい足を使って判定する | 採用 | 2026-09-26 |
