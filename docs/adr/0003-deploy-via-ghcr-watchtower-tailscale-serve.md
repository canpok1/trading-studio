# 0003. GHCR と Watchtower で自宅サーバーへ自動デプロイし、Tailscale Serve で開く

- ステータス: 採用（公開範囲の決定は [0004](0004-lan-exposure-until-live-trading.md) で置き換え）
- 日付: 2026-09-25

## コンテキスト

自宅サーバー（mini-pc）で常時動かし、主にスマホから開く（Issue #1・#5）。アプリにログイン機能は作らないため、インターネットには公開できない。仕組みは health-connect-converter と同じにする（Issue #5）。

## 決定

- main への push で CI がイメージを GHCR へ push する（タグは `latest` とコミット ID）。PR ではビルドだけ確かめる
- mini-pc 上の Watchtower が5分間隔で `latest` を確認して入れ替える
- コンテナは UID/GID `1000:1000` で動かし、DB を置く `data/` を bind mount する
- ホストへは `127.0.0.1:3000` にだけ公開し、Tailscale Serve で HTTPS 化して tailnet 内から開く

## 結果

- main の変更が5分以内に本番へ反映される。手作業のデプロイが無い
- 取引中でも再起動がかかる。フェーズ4・5では、再起動しても取引の状態と注文を復元できることを条件にしている
- 壊れた変更も main に入れば反映される。CI の検査と、マイグレーション前の自動バックアップ（ADR 0002）で守る
- 以前のイメージにはコミット ID のタグで戻せる

## 検討した代替案

- コンテナ内で `HOST` を Tailscale のアドレスにして直接待ち受ける：コンテナのネットワークと合わず、設定に IP アドレスを書くことになる
- cloudflared で公開する：インターネットに公開され、認証の無いアプリを誰でも操作できてしまう
- mini-pc 上で git pull してビルドする：mini-pc にビルド環境が要り、health-connect-converter と運用がそろわない
