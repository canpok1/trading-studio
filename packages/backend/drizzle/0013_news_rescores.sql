CREATE TABLE `news_rescores` (
	`news_id` integer NOT NULL,
	`criteria_version` integer NOT NULL,
	`status` text NOT NULL,
	`risk` integer,
	`sentiment` integer,
	`comment` text,
	`scored_at` integer,
	`model` text,
	`app_built_at` integer,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`requested_at` integer NOT NULL,
	PRIMARY KEY(`news_id`, `criteria_version`),
	FOREIGN KEY (`news_id`) REFERENCES `news`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `news_rescores_status` ON `news_rescores` (`status`);--> statement-breakpoint
ALTER TABLE `backtest_runs` ADD `criteria_version` integer;