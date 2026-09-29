-- トレンドをセンチメントへ統合する。新しいセンチメントの定義は旧トレンドと同じ（強気材料か弱気材料か）なので、過去の点数はトレンドの点数で置き換える（旧センチメントは捨てる）
UPDATE `news_scores` SET `sentiment` = `trend`;--> statement-breakpoint
-- 戦略の条件のトレンド判定をセンチメント判定へ書き換える。上昇→+2・+1、レンジ→0、下落→−1・−2、データなし→データなし
UPDATE `strategies` SET `params` = json_set(`params`, '$.buy.conditions', json((
	SELECT json_group_array(json(x)) FROM (
		SELECT CASE
			WHEN json_extract(c.value, '$.type') = 'judgment' AND json_extract(c.value, '$.judge') = 'trend'
			THEN json_object('type', 'judgment', 'judge', 'sentiment', 'values', json((
				SELECT json_group_array(v) FROM (
					SELECT m.v FROM (SELECT '+2' AS v, 0 AS o, 'up' AS k UNION ALL SELECT '+1', 1, 'up' UNION ALL SELECT '0', 2, 'range' UNION ALL SELECT '-1', 3, 'down' UNION ALL SELECT '-2', 4, 'down' UNION ALL SELECT 'none', 5, 'none') m
					WHERE m.k IN (SELECT value FROM json_each(c.value, '$.values'))
					ORDER BY m.o))))
			ELSE c.value END AS x
		FROM json_each(`strategies`.`params`, '$.buy.conditions') c ORDER BY c.key))))
WHERE json_valid(`params`) AND json_type(`params`, '$.buy.conditions') = 'array';--> statement-breakpoint
UPDATE `strategies` SET `params` = json_set(`params`, '$.takeProfit.conditions', json((
	SELECT json_group_array(json(x)) FROM (
		SELECT CASE
			WHEN json_extract(c.value, '$.type') = 'judgment' AND json_extract(c.value, '$.judge') = 'trend'
			THEN json_object('type', 'judgment', 'judge', 'sentiment', 'values', json((
				SELECT json_group_array(v) FROM (
					SELECT m.v FROM (SELECT '+2' AS v, 0 AS o, 'up' AS k UNION ALL SELECT '+1', 1, 'up' UNION ALL SELECT '0', 2, 'range' UNION ALL SELECT '-1', 3, 'down' UNION ALL SELECT '-2', 4, 'down' UNION ALL SELECT 'none', 5, 'none') m
					WHERE m.k IN (SELECT value FROM json_each(c.value, '$.values'))
					ORDER BY m.o))))
			ELSE c.value END AS x
		FROM json_each(`strategies`.`params`, '$.takeProfit.conditions') c ORDER BY c.key))))
WHERE json_valid(`params`) AND json_type(`params`, '$.takeProfit.conditions') = 'array';--> statement-breakpoint
UPDATE `strategies` SET `params` = json_set(`params`, '$.stopLoss.conditions', json((
	SELECT json_group_array(json(x)) FROM (
		SELECT CASE
			WHEN json_extract(c.value, '$.type') = 'judgment' AND json_extract(c.value, '$.judge') = 'trend'
			THEN json_object('type', 'judgment', 'judge', 'sentiment', 'values', json((
				SELECT json_group_array(v) FROM (
					SELECT m.v FROM (SELECT '+2' AS v, 0 AS o, 'up' AS k UNION ALL SELECT '+1', 1, 'up' UNION ALL SELECT '0', 2, 'range' UNION ALL SELECT '-1', 3, 'down' UNION ALL SELECT '-2', 4, 'down' UNION ALL SELECT 'none', 5, 'none') m
					WHERE m.k IN (SELECT value FROM json_each(c.value, '$.values'))
					ORDER BY m.o))))
			ELSE c.value END AS x
		FROM json_each(`strategies`.`params`, '$.stopLoss.conditions') c ORDER BY c.key))))
WHERE json_valid(`params`) AND json_type(`params`, '$.stopLoss.conditions') = 'array';--> statement-breakpoint
UPDATE `backtest_runs` SET `params` = json_set(`params`, '$.buy.conditions', json((
	SELECT json_group_array(json(x)) FROM (
		SELECT CASE
			WHEN json_extract(c.value, '$.type') = 'judgment' AND json_extract(c.value, '$.judge') = 'trend'
			THEN json_object('type', 'judgment', 'judge', 'sentiment', 'values', json((
				SELECT json_group_array(v) FROM (
					SELECT m.v FROM (SELECT '+2' AS v, 0 AS o, 'up' AS k UNION ALL SELECT '+1', 1, 'up' UNION ALL SELECT '0', 2, 'range' UNION ALL SELECT '-1', 3, 'down' UNION ALL SELECT '-2', 4, 'down' UNION ALL SELECT 'none', 5, 'none') m
					WHERE m.k IN (SELECT value FROM json_each(c.value, '$.values'))
					ORDER BY m.o))))
			ELSE c.value END AS x
		FROM json_each(`backtest_runs`.`params`, '$.buy.conditions') c ORDER BY c.key))))
WHERE json_valid(`params`) AND json_type(`params`, '$.buy.conditions') = 'array';--> statement-breakpoint
UPDATE `backtest_runs` SET `params` = json_set(`params`, '$.takeProfit.conditions', json((
	SELECT json_group_array(json(x)) FROM (
		SELECT CASE
			WHEN json_extract(c.value, '$.type') = 'judgment' AND json_extract(c.value, '$.judge') = 'trend'
			THEN json_object('type', 'judgment', 'judge', 'sentiment', 'values', json((
				SELECT json_group_array(v) FROM (
					SELECT m.v FROM (SELECT '+2' AS v, 0 AS o, 'up' AS k UNION ALL SELECT '+1', 1, 'up' UNION ALL SELECT '0', 2, 'range' UNION ALL SELECT '-1', 3, 'down' UNION ALL SELECT '-2', 4, 'down' UNION ALL SELECT 'none', 5, 'none') m
					WHERE m.k IN (SELECT value FROM json_each(c.value, '$.values'))
					ORDER BY m.o))))
			ELSE c.value END AS x
		FROM json_each(`backtest_runs`.`params`, '$.takeProfit.conditions') c ORDER BY c.key))))
WHERE json_valid(`params`) AND json_type(`params`, '$.takeProfit.conditions') = 'array';--> statement-breakpoint
UPDATE `backtest_runs` SET `params` = json_set(`params`, '$.stopLoss.conditions', json((
	SELECT json_group_array(json(x)) FROM (
		SELECT CASE
			WHEN json_extract(c.value, '$.type') = 'judgment' AND json_extract(c.value, '$.judge') = 'trend'
			THEN json_object('type', 'judgment', 'judge', 'sentiment', 'values', json((
				SELECT json_group_array(v) FROM (
					SELECT m.v FROM (SELECT '+2' AS v, 0 AS o, 'up' AS k UNION ALL SELECT '+1', 1, 'up' UNION ALL SELECT '0', 2, 'range' UNION ALL SELECT '-1', 3, 'down' UNION ALL SELECT '-2', 4, 'down' UNION ALL SELECT 'none', 5, 'none') m
					WHERE m.k IN (SELECT value FROM json_each(c.value, '$.values'))
					ORDER BY m.o))))
			ELSE c.value END AS x
		FROM json_each(`backtest_runs`.`params`, '$.stopLoss.conditions') c ORDER BY c.key))))
WHERE json_valid(`params`) AND json_type(`params`, '$.stopLoss.conditions') = 'array';--> statement-breakpoint
UPDATE `backtest_advice` SET `content` = json_set(`content`, '$.improved.params.buy.conditions', json((
	SELECT json_group_array(json(x)) FROM (
		SELECT CASE
			WHEN json_extract(c.value, '$.type') = 'judgment' AND json_extract(c.value, '$.judge') = 'trend'
			THEN json_object('type', 'judgment', 'judge', 'sentiment', 'values', json((
				SELECT json_group_array(v) FROM (
					SELECT m.v FROM (SELECT '+2' AS v, 0 AS o, 'up' AS k UNION ALL SELECT '+1', 1, 'up' UNION ALL SELECT '0', 2, 'range' UNION ALL SELECT '-1', 3, 'down' UNION ALL SELECT '-2', 4, 'down' UNION ALL SELECT 'none', 5, 'none') m
					WHERE m.k IN (SELECT value FROM json_each(c.value, '$.values'))
					ORDER BY m.o))))
			ELSE c.value END AS x
		FROM json_each(`backtest_advice`.`content`, '$.improved.params.buy.conditions') c ORDER BY c.key))))
WHERE json_valid(`content`) AND json_type(`content`, '$.improved.params.buy.conditions') = 'array' AND json_extract(`content`, '$.improved.ok') = 1;--> statement-breakpoint
UPDATE `backtest_advice` SET `content` = json_set(`content`, '$.improved.params.takeProfit.conditions', json((
	SELECT json_group_array(json(x)) FROM (
		SELECT CASE
			WHEN json_extract(c.value, '$.type') = 'judgment' AND json_extract(c.value, '$.judge') = 'trend'
			THEN json_object('type', 'judgment', 'judge', 'sentiment', 'values', json((
				SELECT json_group_array(v) FROM (
					SELECT m.v FROM (SELECT '+2' AS v, 0 AS o, 'up' AS k UNION ALL SELECT '+1', 1, 'up' UNION ALL SELECT '0', 2, 'range' UNION ALL SELECT '-1', 3, 'down' UNION ALL SELECT '-2', 4, 'down' UNION ALL SELECT 'none', 5, 'none') m
					WHERE m.k IN (SELECT value FROM json_each(c.value, '$.values'))
					ORDER BY m.o))))
			ELSE c.value END AS x
		FROM json_each(`backtest_advice`.`content`, '$.improved.params.takeProfit.conditions') c ORDER BY c.key))))
WHERE json_valid(`content`) AND json_type(`content`, '$.improved.params.takeProfit.conditions') = 'array' AND json_extract(`content`, '$.improved.ok') = 1;--> statement-breakpoint
UPDATE `backtest_advice` SET `content` = json_set(`content`, '$.improved.params.stopLoss.conditions', json((
	SELECT json_group_array(json(x)) FROM (
		SELECT CASE
			WHEN json_extract(c.value, '$.type') = 'judgment' AND json_extract(c.value, '$.judge') = 'trend'
			THEN json_object('type', 'judgment', 'judge', 'sentiment', 'values', json((
				SELECT json_group_array(v) FROM (
					SELECT m.v FROM (SELECT '+2' AS v, 0 AS o, 'up' AS k UNION ALL SELECT '+1', 1, 'up' UNION ALL SELECT '0', 2, 'range' UNION ALL SELECT '-1', 3, 'down' UNION ALL SELECT '-2', 4, 'down' UNION ALL SELECT 'none', 5, 'none') m
					WHERE m.k IN (SELECT value FROM json_each(c.value, '$.values'))
					ORDER BY m.o))))
			ELSE c.value END AS x
		FROM json_each(`backtest_advice`.`content`, '$.improved.params.stopLoss.conditions') c ORDER BY c.key))))
WHERE json_valid(`content`) AND json_type(`content`, '$.improved.params.stopLoss.conditions') = 'array' AND json_extract(`content`, '$.improved.ok') = 1;--> statement-breakpoint
-- 集計ルールのトレンドのしきい値を消す
UPDATE `settings` SET `value` = json_remove(`value`, '$.thresholds.trend') WHERE `key` = 'aggregation_rule' AND json_valid(`value`);--> statement-breakpoint
UPDATE `backtest_runs` SET `aggregation_rule` = json_remove(`aggregation_rule`, '$.thresholds.trend') WHERE `aggregation_rule` IS NOT NULL AND json_valid(`aggregation_rule`);--> statement-breakpoint
ALTER TABLE `news_scores` DROP COLUMN `trend`;