CREATE TABLE `news_scores` (
	`news_id` integer PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`trend` integer,
	`risk` integer,
	`sentiment` integer,
	`comment` text,
	`scored_at` integer,
	`criteria_version` integer,
	`model` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	FOREIGN KEY (`news_id`) REFERENCES `news`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `news_scores_status` ON `news_scores` (`status`);--> statement-breakpoint
CREATE INDEX `news_scores_scored_at` ON `news_scores` (`scored_at`);--> statement-breakpoint
CREATE TABLE `scoring_criteria` (
	`version` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`text` text NOT NULL,
	`note` text NOT NULL,
	`created_at` integer NOT NULL
);
