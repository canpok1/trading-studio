CREATE TABLE `datasets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_time` integer NOT NULL,
	`to_time` integer NOT NULL,
	`regime` text NOT NULL,
	`return_ppm` integer NOT NULL,
	`volatility_ppm` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `datasets_period` ON `datasets` (`from_time`,`to_time`);--> statement-breakpoint
ALTER TABLE `backtest_runs` ADD `dataset_id` integer;--> statement-breakpoint
ALTER TABLE `backtest_runs` ADD `dataset_regime` text;