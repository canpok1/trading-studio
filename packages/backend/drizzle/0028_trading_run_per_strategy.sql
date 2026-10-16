-- 戦略と運用を 1:1 にする（ADR 0031）。同じ戦略を使う運用が2つ以上あれば、最後の一意索引で失敗して適用されない
UPDATE `trading_runs` SET `mode` = 'paper' WHERE `deleted_at` IS NULL AND `mode` = 'live';--> statement-breakpoint
UPDATE `trading_orders` SET `status` = 'canceled', `canceled_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000, `cancel_reason` = '戦略と運用の統合で取消'
	WHERE `status` = 'open' AND `run_id` IN (
		SELECT `id` FROM `trading_runs` WHERE `deleted_at` IS NULL
		AND (`strategy_id` IS NULL OR `strategy_id` NOT IN (SELECT `id` FROM `strategies`))
	);--> statement-breakpoint
UPDATE `trading_runs` SET `deleted_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000, `enabled` = 0, `next_eval_at` = NULL, `reevaluate` = 0
	WHERE `deleted_at` IS NULL AND (`strategy_id` IS NULL OR `strategy_id` NOT IN (SELECT `id` FROM `strategies`));--> statement-breakpoint
INSERT INTO `trading_runs` (`name`, `mode`, `strategy_id`, `created_at`, `enabled`, `state`, `reevaluate`, `initial_cash`, `account`, `reset_at`)
	SELECT `name`, 'paper', `id`, CAST(strftime('%s', 'now') AS INTEGER) * 1000, 0, 'null', 0, 1000000, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000
	FROM `strategies` WHERE `id` NOT IN (SELECT `strategy_id` FROM `trading_runs` WHERE `deleted_at` IS NULL AND `strategy_id` IS NOT NULL)
	ORDER BY `id`;--> statement-breakpoint
CREATE UNIQUE INDEX `trading_runs_strategy` ON `trading_runs` (`strategy_id`) WHERE "trading_runs"."deleted_at" is null;
