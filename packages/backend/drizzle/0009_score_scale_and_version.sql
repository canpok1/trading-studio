ALTER TABLE `news_scores` ADD `app_built_at` integer;--> statement-breakpoint
-- トレンドとセンチメントの点数を 0〜100（50 が中立）から -100〜100（0 が中立）へ換算する。リスクは 0〜100 のまま
UPDATE `news_scores` SET `trend` = (`trend` - 50) * 2 WHERE `trend` IS NOT NULL;--> statement-breakpoint
UPDATE `news_scores` SET `sentiment` = (`sentiment` - 50) * 2 WHERE `sentiment` IS NOT NULL;--> statement-breakpoint
-- 保存済みの集計ルールと、バックテストの実行時のルールのしきい値も同じく換算する
UPDATE `settings` SET `value` = json_set(`value`,
	'$.thresholds.trend.up', (json_extract(`value`, '$.thresholds.trend.up') - 50) * 2,
	'$.thresholds.trend.down', (json_extract(`value`, '$.thresholds.trend.down') - 50) * 2,
	'$.thresholds.sentiment.plus2', (json_extract(`value`, '$.thresholds.sentiment.plus2') - 50) * 2,
	'$.thresholds.sentiment.plus1', (json_extract(`value`, '$.thresholds.sentiment.plus1') - 50) * 2,
	'$.thresholds.sentiment.minus1', (json_extract(`value`, '$.thresholds.sentiment.minus1') - 50) * 2,
	'$.thresholds.sentiment.minus2', (json_extract(`value`, '$.thresholds.sentiment.minus2') - 50) * 2)
WHERE `key` = 'aggregation_rule' AND json_valid(`value`);--> statement-breakpoint
UPDATE `backtest_runs` SET `aggregation_rule` = json_set(`aggregation_rule`,
	'$.thresholds.trend.up', (json_extract(`aggregation_rule`, '$.thresholds.trend.up') - 50) * 2,
	'$.thresholds.trend.down', (json_extract(`aggregation_rule`, '$.thresholds.trend.down') - 50) * 2,
	'$.thresholds.sentiment.plus2', (json_extract(`aggregation_rule`, '$.thresholds.sentiment.plus2') - 50) * 2,
	'$.thresholds.sentiment.plus1', (json_extract(`aggregation_rule`, '$.thresholds.sentiment.plus1') - 50) * 2,
	'$.thresholds.sentiment.minus1', (json_extract(`aggregation_rule`, '$.thresholds.sentiment.minus1') - 50) * 2,
	'$.thresholds.sentiment.minus2', (json_extract(`aggregation_rule`, '$.thresholds.sentiment.minus2') - 50) * 2)
WHERE `aggregation_rule` IS NOT NULL AND json_valid(`aggregation_rule`);
