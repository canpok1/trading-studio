CREATE TABLE `backtest_results` (
	`run_id` integer PRIMARY KEY NOT NULL,
	`bars` blob NOT NULL,
	`orders` blob NOT NULL,
	`trades` blob NOT NULL,
	`decisions` blob NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `backtest_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `backtest_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`strategy_id` integer,
	`strategy_name` text NOT NULL,
	`params` text NOT NULL,
	`timeframe` text NOT NULL,
	`from_time` integer NOT NULL,
	`to_time` integer NOT NULL,
	`initial_cash` integer NOT NULL,
	`fee_limit_ppm` integer NOT NULL,
	`fee_market_ppm` integer NOT NULL,
	`skip_gaps` integer NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`bar_count` integer NOT NULL,
	`summary` text,
	`filled_count` integer DEFAULT 0 NOT NULL,
	`order_count` integer DEFAULT 0 NOT NULL,
	`error` text
);
