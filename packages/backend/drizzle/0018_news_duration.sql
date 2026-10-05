ALTER TABLE `news_rescores` ADD `duration` text;--> statement-breakpoint
ALTER TABLE `news_scores` ADD `duration` text;--> statement-breakpoint
UPDATE `news_scores` SET `duration` = CASE WHEN `sentiment` IS NULL AND `risk` IS NULL THEN 'none' ELSE 'short' END, `sentiment` = coalesce(`sentiment`, 0), `risk` = coalesce(`risk`, 0) WHERE `status` = 'done';--> statement-breakpoint
UPDATE `news_rescores` SET `duration` = CASE WHEN `sentiment` IS NULL AND `risk` IS NULL THEN 'none' ELSE 'short' END, `sentiment` = coalesce(`sentiment`, 0), `risk` = coalesce(`risk`, 0) WHERE `status` = 'done';
