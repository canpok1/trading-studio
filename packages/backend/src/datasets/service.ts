// データセットを作る。起動時・毎日 4:00（JST）・取り込みの後に、まだ作っていない期間を作る。
// 月初に限らず毎日見るのは、月初にサーバーが止まっていた月も拾うため

import {
	classifyMarket,
	DATASET_MIN_COVERAGE_PPM,
	datasetPeriods,
	TIMEFRAME_MS,
} from "@trading-studio/core";
import type { MarketDataRepository } from "../market-data/repository";
import { nextRunTime } from "../retention/service";
import type { DatasetRepository } from "./repository";
import type { DatasetService } from "./types";

export type DatasetEngine = DatasetService & {
	/** 定期的に呼ぶ（main では1分ごと）。前回から 4:00 をまたいでいれば作る */
	tick(): void;
	/** 作れる期間をすべて作り、作った件数を返す */
	build(): number;
	/** build と同じ。失敗しても投げない（常駐処理と取り込みの後に呼ぶ） */
	refresh(): void;
};

export function createDatasetService({
	repo,
	marketData,
	now = Date.now,
}: {
	repo: DatasetRepository;
	marketData: Pick<
		MarketDataRepository,
		"firstCandleTime" | "countCandles" | "loadCandles"
	>;
	now?: () => number;
}): DatasetEngine {
	let nextAt: number | null = null;

	function build(): number {
		const t = now();
		const first = marketData.firstCandleTime("1m");
		if (first === null) return 0;
		let created = 0;
		for (const { from, to } of datasetPeriods(first, t)) {
			if (repo.exists(from, to)) continue;
			// 細かい足がそろっていない期間は、細かい足で判定する戦略のバックテストに使えないので作らない
			const minutes = (to - from) / TIMEFRAME_MS["1m"];
			const have = marketData.countCandles("1m", from, to);
			if (have * 1_000_000 < minutes * DATASET_MIN_COVERAGE_PPM) continue;
			const r = classifyMarket(marketData.loadCandles("1d", from, to));
			if (!r) continue;
			repo.create({ from, to, ...r, createdAt: t });
			created++;
		}
		return created;
	}

	function refresh() {
		try {
			build();
		} catch (e) {
			// 常駐処理を落とさない。次の 4:00 にやり直す
			console.error("datasets: failed to build", e);
		}
	}

	return {
		tick() {
			const t = now();
			if (nextAt !== null && t < nextAt) return;
			nextAt = nextRunTime(t);
			refresh();
		},
		build,
		refresh,
		list: (regime) => repo.list(regime ?? null),
		get: (id) => repo.get(id),
	};
}
