# Architecture Decision Records (ADR)

重要度の高い判断を記録する。フォーマットは MADR 軽量版（日本語本文）。

| 番号 | タイトル | ステータス | 日付 |
|------|----------|------------|------|
| [0001](0001-bun-workspace-biome-bun-test-dependency-cruiser.md) | 開発基盤に Bun workspace・Biome・bun test・dependency-cruiser を使う | 採用 | 2026-09-25 |
| [0002](0002-sqlite-and-epoch-millis.md) | DB に SQLite を使い、時刻を UTC のエポックミリ秒の整数で持つ | 採用 | 2026-09-25 |
| [0003](0003-deploy-via-ghcr-watchtower-tailscale-serve.md) | GHCR と Watchtower で自宅サーバーへ自動デプロイし、Tailscale Serve で開く | 採用（公開範囲は 0004 で置き換え） | 2026-09-25 |
| [0004](0004-lan-exposure-until-live-trading.md) | 実取引を始めるまでは自宅 LAN 内へ公開し、Tailscale は実取引の前に入れる | 採用（2026-09-28 に Tailscale 経由へ切り替え済み） | 2026-09-26 |
| [0005](0005-react-router-and-tailwind.md) | 画面遷移に React Router、CSS に Tailwind CSS v4 を使い、E2E は Playwright で流す | 採用 | 2026-09-26 |
| [0006](0006-backtest-evaluates-on-finer-candles.md) | 判定頻度が足の粒度より短い戦略は、バックテストで細かい足を使って判定する | 採用 | 2026-09-26 |
| [0007](0007-collect-trades-via-public-websocket.md) | 約定は Coincheck の公開 WebSocket で受け、つながった直後は公開 API の直近100件で補う | 採用 | 2026-09-26 |
| [0008](0008-news-sources-and-scoring-model.md) | ニュースは規約上の問題が少ない日本語の RSS 3つから15分おきに集め、Gemini 3.5 Flash-Lite で採点する | 採用 | 2026-09-26 |
| [0009](0009-gemini-api-key-set-from-screen.md) | Gemini の API キーは画面から保存して DB に持ち、画面へは返さない | 採用 | 2026-09-26 |
| [0010](0010-advice-reduces-bars-around-orders.md) | アドバイスで AI に渡す足が多すぎるときは、全体を粗い足にし注文の前後だけ戦略の足で渡す | 採用 | 2026-09-27 |
| [0011](0011-hold-positions-as-lots.md) | 保有を買い1件ごとのロットで持ち、売りはロットごとに判定する | 採用 | 2026-09-27 |
| [0012](0012-mcp-in-backend-for-claude-code.md) | Claude Code から戦略を相談できるよう、backend に MCP を内蔵する | 採用（採点の基準は 0013 で例外） | 2026-09-27 |
| [0013](0013-mcp-can-switch-scoring-criteria.md) | MCP からニュースの採点の基準の版を保存し、使用する版を切り替えられるようにする | 採用 | 2026-09-28 |
