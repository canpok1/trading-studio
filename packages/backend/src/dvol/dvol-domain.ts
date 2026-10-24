// DVOL（Deribit の BTC の30日の予想ボラ）の1時間足の取得。1時間ごとに、最後に保存した足から今までを取る（docs/adr/0032）

import type { ConditionSet, DvolPoint, Timeframe } from "@trading-studio/core";
import {
	COINCHECK,
	candleStart,
	conditionStrategy,
	dvolAverageSeries,
	isCoarser,
	isTimeframe,
	LIMITS,
} from "@trading-studio/core";
import { CHART_RANGE_MS } from "../market/market-domain";
import type { ChartRangeId } from "../market/types-domain";
import type { DvolRepository } from "./repository-domain";
import type { DvolBar, DvolService, DvolStatus } from "./types-domain";

const HOUR_MS = 3_600_000;
export const FETCH_INTERVAL_MS = HOUR_MS;
/** Deribit が1時間足を持つ最初の時刻。これより前は空 */
export const DVOL_FIRST_TIME = Date.UTC(2021, 2, 24);
/** 1回の問い合わせで取る本数。Deribit は1回1000本まで返す */
const WINDOW_BARS = 1000;
/** 一度に返す足の上限 */
export const DVOL_BARS_MAX = 50_000;

/** 取得の終わりの記録は取得を始めた後なので、この分だけ前を取得の時刻とみなす */
const FETCH_MARGIN_MS = 5 * 60_000;

/**
 * 戦略の DVOL の条件に渡す1時間足。範囲は、判定の時刻 [from, to] に戦略が頼む長さを前に足したもの。
 * 最後に取得した時点で終わっていた足だけを返す（終わる前に取った足は途中の値のまま保存されているため）。条件が無ければ空
 */
export function strategyDvol(
	repo: Pick<DvolRepository, "bars" | "fetchState">,
	params: ConditionSet,
	from: number,
	to: number,
): DvolPoint[] {
	const ms = conditionStrategy.dvolMs(params);
	if (ms === 0) return [];
	const fetched = repo.fetchState().lastSuccessAt;
	if (fetched === null) return [];
	const end = Math.min(to, fetched - FETCH_MARGIN_MS - HOUR_MS + 1);
	return repo
		.bars(from - ms, end)
		.map((b) => ({ time: b.time, close: b.close }));
}

/** 開始が [from, to] の1時間足を取る手段。テストでは偽物に差し替える */
export type FetchDvol = (from: number, to: number) => Promise<DvolBar[]>;

/**
 * 期間の問い合わせ。from・to は必須の整数、timeframe は任意の足の粒度、averageDays は任意の平均の日数（戦略の条件と同じ範囲）。
 * 形が違えば null
 */
export function parseDvolBarsQuery(q: Record<string, string | undefined>): {
	from: number;
	to: number;
	timeframe?: Timeframe;
	averageDays?: number;
} | null {
	const from = Number(q.from);
	const to = Number(q.to);
	if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return null;
	let timeframe: Timeframe | undefined;
	if (q.timeframe !== undefined) {
		if (!isTimeframe(q.timeframe)) return null;
		timeframe = q.timeframe;
	}
	let averageDays: number | undefined;
	if (q.averageDays !== undefined) {
		const d = Number(q.averageDays);
		const r = LIMITS.dvolDays;
		if (!Number.isInteger(d) || d < r.min || d > r.max) return null;
		averageDays = d;
	}
	return {
		from,
		to,
		...(timeframe ? { timeframe } : {}),
		...(averageDays ? { averageDays } : {}),
	};
}

/**
 * 足ごとに、その1時間足が終わった時点の直近 days 日の平均（×100）を付ける。足りなければ null。
 * 条件の判定（core の dvolAverage）と同じ計算。points は平均に要る前の期間を含む1時間足（古い順）
 */
export function withAverage(
	bars: DvolBar[],
	points: readonly DvolBar[],
	days: number,
): DvolBar[] {
	const avgs = dvolAverageSeries(
		points,
		bars.map((b) => b.time + HOUR_MS),
		days,
	);
	return bars.map((b, i) => ({ ...b, average: avgs[i] ?? null }));
}

// DVOL は BTC の指標なので、BTC/JPY を扱う Coincheck の暦で足を区切る（市場への紐づけは #263）
const DVOL_CALENDAR = COINCHECK.calendar;

/** 1時間より粗い足では、足ごとに最後の1時間足だけ残す。チャートが使うのはそれだけで、全期間の日足でも本数を抑えるため */
function thin(bars: DvolBar[], timeframe: Timeframe | undefined): DvolBar[] {
	if (timeframe === undefined || !isCoarser(timeframe, "1h")) return bars;
	return bars.filter((b, i) => {
		const next = bars[i + 1];
		return (
			next === undefined ||
			candleStart(next.time, timeframe, DVOL_CALENDAR) !==
				candleStart(b.time, timeframe, DVOL_CALENDAR)
		);
	});
}

export type DvolCollector = DvolService & {
	/** 定期的に呼ぶ（main では1分ごと）。前の取得から1時間たっていれば取得する */
	tick(): void;
	/** 取得を1回行う。すでに動いていれば、その回の終わりを待つ */
	run(): Promise<void>;
	/** MCP 用。期間の中の新しいほうから limit 本を古い順に。averageDays があれば足ごとの平均を付ける */
	recent(range: ChartRangeId, limit: number, averageDays?: number): DvolBar[];
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
		bars(from, to, timeframe, averageDays) {
			if (timeframe === undefined || !isCoarser(timeframe, "1h")) {
				const count = repo.count(from, to);
				if (count > DVOL_BARS_MAX) {
					return { ok: false, kind: "too_many", count, max: DVOL_BARS_MAX };
				}
			}
			if (averageDays === undefined) {
				return { ok: true, bars: thin(repo.bars(from, to), timeframe) };
			}
			const points = repo.bars(from - averageDays * 24 * HOUR_MS, to);
			const bars = thin(
				points.filter((b) => b.time >= from),
				timeframe,
			);
			return { ok: true, bars: withAverage(bars, points, averageDays) };
		},
		recent(range, limit, averageDays) {
			const t = now();
			const from =
				range === "all" ? Number.MIN_SAFE_INTEGER : t - CHART_RANGE_MS[range];
			const points = repo.bars(
				averageDays === undefined || range === "all"
					? from
					: from - averageDays * 24 * HOUR_MS,
				t + HOUR_MS,
			);
			// 平均のために前へ広げた分は返さない
			const inRange = points.filter((b) => b.time >= from);
			const bars = inRange.slice(Math.max(0, inRange.length - limit));
			return averageDays === undefined
				? bars
				: withAverage(bars, points, averageDays);
		},
	};
	return service;
}
