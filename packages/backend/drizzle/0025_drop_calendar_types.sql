DROP TABLE `calendar_coverage`;--> statement-breakpoint
DROP TABLE `calendar_events`;--> statement-breakpoint
ALTER TABLE `event_sources` DROP COLUMN `keywords`;--> statement-breakpoint
UPDATE `event_sources` SET `first_success_at` = NULL, `last_success_at` = NULL, `last_error` = NULL, `error_since` = NULL;
