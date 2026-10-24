-- 銘柄・市場を持たせる（ADR 0036）。既存の行は BTC/JPY・Coincheck として埋める
DROP INDEX `segments_period`;--> statement-breakpoint
ALTER TABLE `segments` ADD `instrument` text DEFAULT 'coincheck:btc_jpy' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `segments_period` ON `segments` (`instrument`,`from_time`,`to_time`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_candles` (
	`instrument` text DEFAULT 'coincheck:btc_jpy' NOT NULL,
	`timeframe` text NOT NULL,
	`time` integer NOT NULL,
	`open` integer NOT NULL,
	`high` integer NOT NULL,
	`low` integer NOT NULL,
	`close` integer NOT NULL,
	`volume` integer NOT NULL,
	`source` text NOT NULL,
	`import_id` integer,
	PRIMARY KEY(`instrument`, `timeframe`, `time`),
	FOREIGN KEY (`import_id`) REFERENCES `data_imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_candles`("instrument", "timeframe", "time", "open", "high", "low", "close", "volume", "source", "import_id") SELECT 'coincheck:btc_jpy', "timeframe", "time", "open", "high", "low", "close", "volume", "source", "import_id" FROM `candles`;--> statement-breakpoint
DROP TABLE `candles`;--> statement-breakpoint
ALTER TABLE `__new_candles` RENAME TO `candles`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `candles_import_id` ON `candles` (`import_id`);--> statement-breakpoint
ALTER TABLE `backtest_runs` ADD `instrument` text DEFAULT 'coincheck:btc_jpy' NOT NULL;--> statement-breakpoint
ALTER TABLE `data_imports` ADD `instrument` text DEFAULT 'coincheck:btc_jpy' NOT NULL;--> statement-breakpoint
ALTER TABLE `strategies` ADD `market` text DEFAULT 'coincheck' NOT NULL;--> statement-breakpoint
ALTER TABLE `trading_orders` ADD `instrument` text DEFAULT 'coincheck:btc_jpy' NOT NULL;