CREATE TABLE `calendar_coverage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`type` text NOT NULL,
	`from` integer NOT NULL,
	`until` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `event_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `calendar_coverage_source` ON `calendar_coverage` (`source_id`,`type`);--> statement-breakpoint
CREATE TABLE `calendar_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`type` text NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `event_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `calendar_events_source_start` ON `calendar_events` (`source_id`,`start`);--> statement-breakpoint
CREATE TABLE `event_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`keywords` text NOT NULL,
	`created_at` integer NOT NULL,
	`first_success_at` integer,
	`last_success_at` integer,
	`last_error` text,
	`error_since` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_sources_url_unique` ON `event_sources` (`url`);