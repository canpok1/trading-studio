ALTER TABLE `datasets` RENAME TO `segments`;--> statement-breakpoint
DROP INDEX `datasets_period`;--> statement-breakpoint
CREATE UNIQUE INDEX `segments_period` ON `segments` (`from_time`,`to_time`);--> statement-breakpoint
ALTER TABLE `backtest_runs` RENAME COLUMN `dataset_id` TO `segment_id`;--> statement-breakpoint
ALTER TABLE `backtest_runs` RENAME COLUMN `dataset_regime` TO `segment_regime`;
