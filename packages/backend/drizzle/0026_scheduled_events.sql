CREATE TABLE `event_coverage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`from` integer NOT NULL,
	`until` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `event_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `event_coverage_source` ON `event_coverage` (`source_id`);--> statement-breakpoint
CREATE TABLE `event_criteria` (
	`version` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`text` text NOT NULL,
	`note` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_judgments` (
	`event_id` integer NOT NULL,
	`criteria_version` integer NOT NULL,
	`status` text NOT NULL,
	`importance` text,
	`reason` text,
	`judged_at` integer,
	`model` text,
	`app_built_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`next_attempt_at` integer,
	`requested_at` integer NOT NULL,
	PRIMARY KEY(`event_id`, `criteria_version`),
	FOREIGN KEY (`event_id`) REFERENCES `scheduled_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `event_judgments_status` ON `event_judgments` (`status`);--> statement-breakpoint
CREATE TABLE `scheduled_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer,
	`uid` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	`all_day` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `event_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scheduled_events_start` ON `scheduled_events` (`start`);--> statement-breakpoint
CREATE INDEX `scheduled_events_source_uid` ON `scheduled_events` (`source_id`,`uid`);