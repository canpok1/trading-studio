// 相場データを作る。起動時・毎日 4:00（JST）・取り込みの後に、まだ作っていない期間を作る。
// 月初に限らず毎日見るのは、月初にサーバーが止まっていた月も拾うため

import {
	classifyMarket,
	SEGMENT_LEAD_MS,
	SEGMENT_MIN_COVERAGE_PPM,
	segmentPeriods,
	TIMEFRAME_MS,
} from "@trading-studio/core";
import type { MarketDataRepository } from "../market-data/repository";
import { nextRunTime } from "../retention/service";
import type { SegmentRepository } from "./repository";
import type { SegmentService } from "./types";

const SETTLE_MS = 3_600_000;

export type SegmentEngine = SegmentService & {
	/** 定期的に呼ぶ（main では1分ごと）。前回から 4:00 をまたいでいれば作る */
	tick(): void;
	/** 作れる期間をすべて作り、作った件数を返す */
	build(): number;
	/** build と同じ。失敗しても投げない（常駐処理と取り込みの後に呼ぶ） */
	refresh(): void;
};

export function createSegmentService({
	repo,
	marketData,
	newsDeletedBefore,
	now = Date.now,
}: {
	repo: SegmentRepository;
	marketData: Pick<
		MarketDataRepository,
		"firstCandleTime" | "countCandles" | "loadCandles"
	>;
	/** 古いニュースを消した境目（ScoreRepository） */
	newsDeletedBefore: () => number | null;
	now?: () => number;
}): SegmentEngine {
	let nextAt: number | null = null;

	function build(): number {
		const t = now();
		const first = marketData.firstCandleTime("1m");
		if (first === null) return 0;
		const deleted = newsDeletedBefore();
		let created = 0;
		// 月が替わった直後は前の月の最後の足がまだ確定していないことがあるので、1時間待ってから作る
		for (const { from, to } of segmentPeriods(first, t - SETTLE_MS)) {
			if (repo.exists(from, to)) continue;
			// 古い足を取り込み直しても、ニュースを消した期間は相場データにしない（市場評価を出せないため）
			if (deleted !== null && from - SEGMENT_LEAD_MS < deleted) continue;
			// 細かい足がそろっていない期間は、細かい足で判定する戦略のバックテストに使えないので作らない
			const minutes = (to - from) / TIMEFRAME_MS["1m"];
			const have = marketData.countCandles("1m", from, to);
			if (have * 1_000_000 < minutes * SEGMENT_MIN_COVERAGE_PPM) continue;
			// 日足が1日でも欠けると、前後の日の変化を1日の変化として数えて値動きが大きく出るので作らない
			const days = marketData.loadCandles("1d", from, to);
			if (days.length !== Math.round((to - from) / TIMEFRAME_MS["1d"])) {
				continue;
			}
			const r = classifyMarket(days);
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
			console.error("segments: failed to build", e);
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
