// DVOL（Deribit の BTC の30日の予想ボラ）の1時間足の取得。1時間ごとに、最後に保存した足から今までを取る（docs/adr/0032）

import { CHART_RANGE_MS } from "../market/market-domain";
import type { ChartRangeId } from "../market/types-domain";
import type { DvolRepository } from "./repository-domain";
import type { DvolBar, DvolService, DvolStatus } from "./types-domain";

const HOUR_MS = 3_600_000;
export const FETCH_INTERVAL_MS = HOUR_MS;
/** Deribit が1時間足を持つ最初の時刻。これより前は空 */
export const DVOL_FIRST_TIME = Date.UTC(2021, 2, 25);
/** 1回の問い合わせで取る本数。Deribit は1回1000本まで返す */
const WINDOW_BARS = 1000;
/** 一度に返す足の上限 */
export const DVOL_BARS_MAX = 50_000;

/** 開始が [from, to] の1時間足を取る手段。テストでは偽物に差し替える */
export type FetchDvol = (from: number, to: number) => Promise<DvolBar[]>;

/** 期間の問い合わせ。from・to は必須の整数。形が違えば null */
export function parseDvolBarsQuery(
	q: Record<string, string | undefined>,
): { from: number; to: number } | null {
	const from = Number(q.from);
	const to = Number(q.to);
	if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return null;
	return { from, to };
}

export type DvolCollector = DvolService & {
	/** 定期的に呼ぶ（main では1分ごと）。前の取得から1時間たっていれば取得する */
	tick(): void;
	/** 取得を1回行う。すでに動いていれば、その回の終わりを待つ */
	run(): Promise<void>;
	/** MCP 用。期間の中の新しいほうから limit 本を古い順に */
	recent(range: ChartRangeId, limit: number): DvolBar[];
};

export function createDvolService({
	repo,
	fetchDvol,
	keepFrom = () => null,
	now = Date.now,
}: {
	repo: DvolRepository;
	fetchDvol: FetchDvol;
	/** 足・ニュース・採点の保持の境目。これより前は取らない（消したそばから取り直さないため）。無期限は null */
	keepFrom?: () => number | null;
	now?: () => number;
}): DvolCollector {
	let lastRunAt: number | null = null;
	let running: Promise<void> | null = null;

	const nextRunAt = () =>
		lastRunAt === null ? null : lastRunAt + FETCH_INTERVAL_MS;

	async function runOnce() {
		lastRunAt = now();
		try {
			const t = now();
			const keep = keepFrom();
			const floor =
				Math.ceil(
					Math.max(DVOL_FIRST_TIME, keep ?? DVOL_FIRST_TIME) / HOUR_MS,
				) * HOUR_MS;
			// 最後の足は確定前かもしれないので取り直す
			let from = Math.max(repo.latestTime() ?? floor, floor);
			// 古い側から順に保存し、途中で失敗しても次の回に最後の足から続けられるようにする（欠けを残さない）
			while (from <= t) {
				const to = Math.min(from + (WINDOW_BARS - 1) * HOUR_MS, t);
				repo.save(await fetchDvol(from, to));
				from = to + HOUR_MS;
			}
			repo.recordSuccess(now());
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			repo.recordFailure(`取得できない: ${message}`, now());
		}
	}

	const service: DvolCollector = {
		tick() {
			if (running) return;
			const next = nextRunAt();
			if (next === null || now() >= next) void service.run();
		},
		run() {
			if (!running) {
				running = runOnce().finally(() => {
					running = null;
				});
			}
			return running;
		},
		status(): DvolStatus {
			return {
				...repo.fetchState(),
				latestBarTime: repo.latestTime(),
				nextRunAt: nextRunAt(),
				running: running !== null,
			};
		},
		bars(from, to) {
			const count = repo.count(from, to);
			if (count > DVOL_BARS_MAX) {
				return { ok: false, kind: "too_many", count, max: DVOL_BARS_MAX };
			}
			return { ok: true, bars: repo.bars(from, to) };
		},
		recent(range, limit) {
			const t = now();
			const from =
				range === "all" ? Number.MIN_SAFE_INTEGER : t - CHART_RANGE_MS[range];
			const bars = repo.bars(from, t + HOUR_MS);
			return bars.slice(Math.max(0, bars.length - limit));
		},
	};
	return service;
}
