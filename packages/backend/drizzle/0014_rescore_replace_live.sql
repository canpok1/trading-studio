ALTER TABLE `news_rescores` ADD `replace_live` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `news_scores` ADD `rescored_at` integer;