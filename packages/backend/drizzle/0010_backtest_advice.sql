CREATE TABLE `advice_instructions` (
	`version` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`text` text NOT NULL,
	`note` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `backtest_advice` (
	`run_id` integer PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`content` text,
	`model` text NOT NULL,
	`instructions_version` integer NOT NULL,
	`app_built_at` integer,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error` text,
	FOREIGN KEY (`run_id`) REFERENCES `backtest_runs`(`id`) ON UPDATE no action ON DELETE no action
);
