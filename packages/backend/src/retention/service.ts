// 古いデータの定期削除。毎日 4:00（JST）に、保持期間を過ぎた判断の記録とバックテストの実行を消す

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
export const RETENTION_DAYS_MAX = 3650;

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
	now = Date.now,
}: {
	repo: RetentionRepository;
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
		const result: RetentionRun = {
			at,
			decisions: 0,
			backtests: 0,
			error: null,
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

	const check = (field: keyof RetentionSettings, v: number | null) =>
		v === null || (Number.isSafeInteger(v) && v >= 1 && v <= RETENTION_DAYS_MAX)
			? null
			: {
					ok: false as const,
					field,
					message: `1〜${RETENTION_DAYS_MAX} 日にする`,
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
				check("backtestsDays", input.backtestsDays);
			if (bad) return bad;
			const settings = {
				decisionsDays: input.decisionsDays,
				backtestsDays: input.backtestsDays,
			};
			repo.saveSettings(settings);
			return { ok: true, settings };
		},
	};
}
