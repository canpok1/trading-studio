-- モードの呼び名をペーパーからデモへ変えたので、名前が「ペーパー」のままのデモの運用（0016 で作った既定の名前）も合わせる
UPDATE `trading_runs` SET `name` = 'デモ' WHERE `name` = 'ペーパー' AND `mode` = 'paper';
