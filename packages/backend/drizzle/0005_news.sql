CREATE TABLE `news` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`source_name` text NOT NULL,
	`language` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`published_at` integer NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `news_url_unique` ON `news` (`url`);--> statement-breakpoint
CREATE INDEX `news_published_at` ON `news` (`published_at`);--> statement-breakpoint
CREATE TABLE `news_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`language` text NOT NULL,
	`enabled` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_success_at` integer,
	`last_error` text,
	`error_since` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `news_sources_url_unique` ON `news_sources` (`url`);