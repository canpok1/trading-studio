CREATE TABLE `auto_trading` (
	`id` integer PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`mode` text NOT NULL,
	`strategy_id` integer,
	`state` text NOT NULL,
	`next_eval_at` integer,
	`reevaluate` integer NOT NULL,
	`started_at` integer
);
--> statement-breakpoint
CREATE TABLE `trading_accounts` (
	`mode` text PRIMARY KEY NOT NULL,
	`initial_cash` integer NOT NULL,
	`account` text NOT NULL,
	`reset_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trading_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mode` text NOT NULL,
	`strategy_id` integer,
	`strategy_name` text NOT NULL,
	`time` integer NOT NULL,
	`decision` text NOT NULL,
	`judgments` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `trading_decisions_time` ON `trading_decisions` (`time`);--> statement-breakpoint
CREATE TABLE `trading_orders` (
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
	`decision_id` integer,
	`strategy_id` integer,
	`strategy_name` text NOT NULL,
	PRIMARY KEY(`mode`, `id`)
);
--> statement-breakpoint
CREATE INDEX `trading_orders_placed_at` ON `trading_orders` (`placed_at`);