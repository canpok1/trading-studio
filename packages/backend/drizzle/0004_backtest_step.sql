ALTER TABLE `backtest_runs` ADD `step_timeframe` text;--> statement-breakpoint
ALTER TABLE `backtest_runs` ADD `step_limited` integer DEFAULT false NOT NULL;