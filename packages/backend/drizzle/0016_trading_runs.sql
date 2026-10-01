CREATE TABLE `trading_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`mode` text NOT NULL,
	`strategy_id` integer,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	`enabled` integer NOT NULL,
	`state` text NOT NULL,
	`next_eval_at` integer,
	`reevaluate` integer NOT NULL,
	`started_at` integer,
	`initial_cash` integer NOT NULL,
	`account` text,
	`reset_at` integer NOT NULL
);
--> statement-breakpoint
-- 今の自動取引（ペーパー）を運用1つ「ペーパー」に移す。口座・実行状態・運用する戦略を引き継ぐ。ライブは動かせなかったので移すものが無い
INSERT INTO `trading_runs` (`id`, `name`, `mode`, `strategy_id`, `created_at`, `deleted_at`, `enabled`, `state`, `next_eval_at`, `reevaluate`, `started_at`, `initial_cash`, `account`, `reset_at`)
SELECT 1, 'ペーパー', 'paper',
	CASE WHEN `a`.`enabled` = 1 AND `a`.`mode` = 'paper' THEN `a`.`strategy_id`
		ELSE (SELECT CAST(`value` AS integer) FROM `settings` WHERE `key` = 'active_strategy_id') END,
	CAST(strftime('%s', 'now') AS integer) * 1000,
	NULL,
	CASE WHEN `a`.`enabled` = 1 AND `a`.`mode` = 'paper' THEN 1 ELSE 0 END,
	CASE WHEN `a`.`enabled` = 1 AND `a`.`mode` = 'paper' THEN `a`.`state` ELSE 'null' END,
	CASE WHEN `a`.`enabled` = 1 AND `a`.`mode` = 'paper' THEN `a`.`next_eval_at` END,
	CASE WHEN `a`.`enabled` = 1 AND `a`.`mode` = 'paper' THEN `a`.`reevaluate` ELSE 0 END,
	CASE WHEN `a`.`enabled` = 1 AND `a`.`mode` = 'paper' THEN `a`.`started_at` END,
	coalesce(`acc`.`initial_cash`, 1000000),
	`acc`.`account`,
	coalesce(`acc`.`reset_at`, CAST(strftime('%s', 'now') AS integer) * 1000)
FROM (SELECT 1) `one`
LEFT JOIN `auto_trading` `a` ON `a`.`id` = 1
LEFT JOIN `trading_accounts` `acc` ON `acc`.`mode` = 'paper';
--> statement-breakpoint
-- 運用する戦略は運用ごとに持つので、全体の設定は消す
DELETE FROM `settings` WHERE `key` = 'active_strategy_id';
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_trading_orders` (
	`run_id` integer NOT NULL,
	`mode` text NOT NULL,
	`id` text NOT NULL,
	`side` text NOT NULL,
	`type` text NOT NULL,
	`price` integer,
	`quantity` integer NOT NULL,
	`placed_at` integer NOT NULL,
	`status` text NOT NULL,
	`filled_at` integer,
	`fill_price` integer,
	`fee` integer,
	`canceled_at` integer,
	`cancel_reason` text,
	`reason` text NOT NULL,
	`pair_id` text,
	`pnl` integer,
	`exit_kind` text,
	`buy_name` text,
	`decision_id` integer,
	`strategy_id` integer,
	`strategy_name` text NOT NULL,
	PRIMARY KEY(`run_id`, `id`)
);
--> statement-breakpoint
INSERT INTO `__new_trading_orders`("run_id", "mode", "id", "side", "type", "price", "quantity", "placed_at", "status", "filled_at", "fill_price", "fee", "canceled_at", "cancel_reason", "reason", "pair_id", "pnl", "exit_kind", "buy_name", "decision_id", "strategy_id", "strategy_name") SELECT 1, "mode", "id", "side", "type", "price", "quantity", "placed_at", "status", "filled_at", "fill_price", "fee", "canceled_at", "cancel_reason", "reason", "pair_id", "pnl", "exit_kind", "buy_name", "decision_id", "strategy_id", "strategy_name" FROM `trading_orders`;--> statement-breakpoint
DROP TABLE `trading_orders`;--> statement-breakpoint
ALTER TABLE `__new_trading_orders` RENAME TO `trading_orders`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `trading_orders_placed_at` ON `trading_orders` (`placed_at`);--> statement-breakpoint
CREATE TABLE `__new_trading_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`mode` text NOT NULL,
	`strategy_id` integer,
	`strategy_name` text NOT NULL,
	`time` integer NOT NULL,
	`decision` text NOT NULL,
	`judgments` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_trading_decisions`("id", "run_id", "mode", "strategy_id", "strategy_name", "time", "decision", "judgments") SELECT "id", 1, "mode", "strategy_id", "strategy_name", "time", "decision", "judgments" FROM `trading_decisions`;--> statement-breakpoint
DROP TABLE `trading_decisions`;--> statement-breakpoint
ALTER TABLE `__new_trading_decisions` RENAME TO `trading_decisions`;--> statement-breakpoint
CREATE INDEX `trading_decisions_time` ON `trading_decisions` (`time`);