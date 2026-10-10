CREATE TABLE `dataset_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dataset_id` integer NOT NULL,
	`dataset_name` text NOT NULL,
	`name` text NOT NULL,
	`segment_ids` text NOT NULL,
	`input` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`summary` text,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `datasets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`segment_ids` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `datasets_name_unique` ON `datasets` (`name`);--> statement-breakpoint
ALTER TABLE `backtest_runs` ADD `dataset_run_id` integer;