// 古いデータの定期削除。毎日 4:00（JST）に、保持期間を過ぎた判断の記録・バックテストの実行・足・ニュースを消す

import { rangesOutside } from "@trading-studio/core";
import type { MarketDataRepository } from "../market-data/repository";
import type { RetentionRepository } from "./repository";
import type {
	RetentionRun,
	RetentionService,
	RetentionSettings,
	SetRetentionResult,
} from "./types";

const DAY_MS = 86_400_000;
/** 毎日の実行時刻。4:00 JST は 19:00 UTC */
const RUN_AT_UTC_MS = 19 * 3_600_000;
/** 1回のトランザクションで消す件数。この単位で他の処理に順番を譲る */
const DECISION_CHUNK = 5000;
const BACKTEST_CHUNK = 20;
const CANDLE_CHUNK = 20_000;
const NEWS_CHUNK = 2000;
export const RETENTION_DAYS_MAX = 3650;
export const RETENTION_YEARS_MAX = 20;

/** t の years 年前（UTC の暦で数える。2/29 は 3/1 になる） */
export function yearsBefore(t: number, years: number): number {
	const d = new Date(t);
	d.setUTCFullYear(d.getUTCFullYear() - years);
	return d.getTime();
}

const yieldToEventLoop = () => new Promise((r) => setTimeout(r, 0));

/** t より後で最初の 4:00（JST） */
export function nextRunTime(t: number): number {
	const since = (((t - RUN_AT_UTC_MS) % DAY_MS) + DAY_MS) % DAY_MS;
	return t - since + DAY_MS;
}

export type RetentionEngine = RetentionService & {
	/** 定期的に呼ぶ（main では1分ごと）。実行時刻を過ぎていれば削除を始める */
	tick(): void;
	/** テストで削除の完了を待つために使う */
	running(): Promise<void> | null;
};

export function createRetentionService({
	repo,
	marketData,
	now = Date.now,
}: {
	repo: RetentionRepository;
	marketData: Pick<MarketDataRepository, "deleteFineCandles">;
	now?: () => number;
}): RetentionEngine {
	let current: Promise<void> | null = null;
	/** 前回の結果が無いときの初回。最初に問い合わせた時点（main では起動時）から数える */
	let firstRunAt: number | null = null;

	const nextRunAt = () => {
		const last = repo.lastRun();
		if (last) return nextRunTime(last.at);
		firstRunAt ??= nextRunTime(now());
		return firstRunAt;
	};

	async function run(at: number) {
		const result: Required<RetentionRun> = {
			at,
			decisions: 0,
			backtests: 0,
			segments: 0,
			candles: 0,
			news: 0,
			error: null,
		};
		/** 消し切るまで chunk 件ずつ消し、合計を返す */
		const drain = async (del: (limit: number) => number, chunk: number) => {
			let total = 0;
			for (;;) {
				const n = del(chunk);
				total += n;
				if (n < chunk) return total;
				await yieldToEventLoop();
			}
		};
		try {
			const s = repo.settings();
			if (s.decisionsDays !== null) {
				const before = at - s.decisionsDays * DAY_MS;
				for (;;) {
					const n = repo.deleteDecisions(before, DECISION_CHUNK);
					result.decisions += n;
					if (n < DECISION_CHUNK) break;
					await yieldToEventLoop();
				}
			}
			if (s.backtestsDays !== null) {
				const before = at - s.backtestsDays * DAY_MS;
				for (;;) {
					const n = repo.deleteBacktests(before, BACKTEST_CHUNK);
					result.backtests += n;
					if (n < BACKTEST_CHUNK) break;
					await yieldToEventLoop();
				}
			}
			if (s.marketDataYears !== null) {
				const before = yearsBefore(at, s.marketDataYears);
				// 消している途中や失敗で止まったときも、消した期間を記録の始まりより前として扱うため、先に覚える
				repo.markNewsDeletedBefore(before);
				// 先に相場データを減らす。残った相場データの期間の足とニュースは消さない
				result.segments = repo.pruneSegments(before);
				for (const r of rangesOutside(before, repo.keptRanges())) {
					result.candles += await drain(
						(n) => marketData.deleteFineCandles(r.from, r.to, n),
						CANDLE_CHUNK,
					);
					result.news += await drain(
						(n) => repo.deleteNews(r.from, r.to, n),
						NEWS_CHUNK,
					);
				}
			}
		} catch (e) {
			console.error("retention: failed to delete old data", e);
			result.error = e instanceof Error ? e.message : String(e);
		}
		try {
			repo.saveLastRun(result);
		} catch (e) {
			// 常駐処理を落とさない。記録できなければ次の見回りでやり直す
			console.error("retention: failed to save the result", e);
		}
	}

	const check = (
		field: keyof RetentionSettings,
		v: number | null,
		max = RETENTION_DAYS_MAX,
		unit = "日",
	) =>
		v === null || (Number.isSafeInteger(v) && v >= 1 && v <= max)
			? null
			: {
					ok: false as const,
					field,
					message: `1〜${max} ${unit}にする`,
				};

	return {
		tick() {
			if (current) return;
			const t = now();
			if (t < nextRunAt()) return;
			current = run(t).finally(() => {
				current = null;
			});
		},
		running: () => current,
		status() {
			return {
				settings: repo.settings(),
				lastRun: repo.lastRun(),
				nextRunAt: nextRunAt(),
				running: current !== null,
				...repo.size(),
				tables: repo.tables(),
			};
		},
		setSettings(input): SetRetentionResult {
			const bad =
				check("decisionsDays", input.decisionsDays) ??
				check("backtestsDays", input.backtestsDays) ??
				check(
					"marketDataYears",
					input.marketDataYears,
					RETENTION_YEARS_MAX,
					"年",
				);
			if (bad) return bad;
			const settings = {
				decisionsDays: input.decisionsDays,
				backtestsDays: input.backtestsDays,
				marketDataYears: input.marketDataYears,
			};
			repo.saveSettings(settings);
			return { ok: true, settings };
		},
	};
}
