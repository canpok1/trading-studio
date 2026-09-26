CREATE TABLE `candles` (
	`timeframe` text NOT NULL,
	`time` integer NOT NULL,
	`open` integer NOT NULL,
	`high` integer NOT NULL,
	`low` integer NOT NULL,
	`close` integer NOT NULL,
	`volume` integer NOT NULL,
	`source` text NOT NULL,
	`import_id` integer,
	PRIMARY KEY(`timeframe`, `time`),
	FOREIGN KEY (`import_id`) REFERENCES `data_imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `candles_import_id` ON `candles` (`import_id`);--> statement-breakpoint
CREATE TABLE `data_imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timeframe` text NOT NULL,
	`file_name` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`total_rows` integer DEFAULT 0 NOT NULL,
	`inserted_rows` integer DEFAULT 0 NOT NULL,
	`skipped_rows` integer DEFAULT 0 NOT NULL,
	`derived_rows` integer DEFAULT 0 NOT NULL,
	`first_time` integer,
	`last_time` integer,
	`error` text
);
