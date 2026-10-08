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
| [0013](0013-mcp-can-switch-scoring-criteria.md) | MCP からニュースの採点の基準の版を保存し、使用する版を切り替えられるようにする | 採用（突き合わせの道具は 0022 で置き換え） | 2026-09-28 |
| [0014](0014-merge-trend-into-sentiment.md) | AI 判定のトレンドをセンチメントへ統合し、観点をセンチメント・リスクの2つにする | 採用 | 2026-09-28 |
| [0015](0015-rescore-by-version-keeps-original-scored-at.md) | 採点の基準の改善は、過去記事を版ごとに採点し直してバックテストで確かめ、使い始める時刻は運用の採点時刻を引き継ぐ | 一部を 0023 で変更 | 2026-09-30 |
| [0016](0016-rescore-from-news-page-replaces-live-score.md) | ニュース画面の採点し直しは運用の採点を置き換え、元の採点は版の採点として残す | 採用 | 2026-09-30 |
| [0017](0017-partial-take-profit-within-lot.md) | 一部利確はロットの一部を売って残りを同じロットに残し、往復は買い1件ごとにまとめる | 採用 | 2026-09-30 |
| [0018](0018-timeframe-per-condition.md) | 足は戦略ではなく条件ごとに持ち、チャートの粒度は戦略から決めない | 採用 | 2026-10-01 |
| [0019](0019-sell-conditions-per-buy.md) | 買いを複数持ち、売りの条件・注文量・最大ロット数は買いごとに持つ | 採用 | 2026-10-01 |
| [0020](0020-trading-run-per-tab.md) | 自動取引を運用（ホームのタブ）ごとに持ち、口座・オンオフ・戦略を運用ごとにする | 採用 | 2026-10-02 |
| [0021](0021-news-weight-by-duration.md) | 市場評価の重みを記事ごとの持続で減らし、関係ない観点は 0 点にそろえる | 採用 | 2026-10-05 |
| [0022](0022-mcp-matches-screen.md) | MCP の道具は画面の機能と一致させ、MCP 独自の分析はやめる | 採用 | 2026-10-08 |
| [0023](0023-news-timing-by-published-at.md) | 記事の精度と分析は公開時刻から測り、バックテストは公開から取得の間隔の後に記事を使う | 採用 | 2026-10-08 |
| [0024](0024-dataset-as-period-with-rule-based-regime.md) | データセットは足を写さず期間と相場のラベルで持ち、ラベルはルールで付ける | 採用 | 2026-10-08 |
