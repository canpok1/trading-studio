-- 戦略に対象の銘柄の一覧を持たせる（ADR 0036）。既存の戦略は BTC/JPY の1つ
ALTER TABLE `strategies` ADD `instruments` text DEFAULT '["coincheck:btc_jpy"]' NOT NULL;