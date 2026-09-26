// 価格収集の常駐処理。取引所から約定を受け続け、確定した1分足を保存する

import type {
	Candle,
	MarketTrade,
	MinuteCandleState,
} from "@trading-studio/core";
import {
	addTrade,
	candleStart,
	closeMinutes,
	compareMarketTrades,
	formingCandle,
	startMinuteCandles,
	TIMEFRAME_MS,
} from "@trading-studio/core";
import type { MarketDataRepository } from "../market-data/repository";
import type { CollectorStatus, LiveMarket, TradeFeed } from "./types";

export type CollectorOptions = {
	feed: TradeFeed;
	repo: MarketDataRepository;
	now?: () => number;
	/** 分が終わってから確定するまでの猶予 */
	graceMs?: number;
	/** この間なにも届かなければ、接続が死んでいるとみなしてつなぎ直す */
	silenceMs?: number;
	/** 接続を始めてから購読が始まるまで待つ上限 */
	connectTimeoutMs?: number;
	/** 購読中に届いた約定を渡す（自動取引の約定の判定に使う）。つなぎ直したときに遡って取った約定は渡さない */
	onTrades?: (trades: readonly MarketTrade[]) => void;
};

/** 再接続の間隔。失敗のたびに倍にし、上限は1分 */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
/** この時間より長く動いてから切れたら、再接続の間隔を最初に戻す（つながってすぐ切れるのを繰り返すときに間隔を延ばすため） */
const STABLE_MS = 60_000;

export type Collector = {
	/** 定期的に呼ぶ（main では1秒ごと）。足の確定・無通信の検知・再接続を行う */
	tick(): void;
	live(): LiveMarket;
	stop(): void;
};

export function createCollector({
	feed,
	repo,
	now = Date.now,
	graceMs = 2_000,
	silenceMs = 60_000,
	connectTimeoutMs = 30_000,
	onTrades,
}: CollectorOptions): Collector {
	let status: CollectorStatus = {
		state: "connecting",
		stoppedSince: null,
		error: null,
		retryAt: null,
		lastReceivedAt: null,
	};
	/** 接続ごとの状態。つなぎ直すたびに作り直し、古い接続からの通知は捨てる */
	let session: {
		id: number;
		conn: { close(): void } | null;
		startedAt: number;
		runningSince: number | null;
		/** 購読が始まり、遡れる範囲を補うまでに届いた約定 */
		buffer: MarketTrade[];
		candles: MinuteCandleState | null;
	} | null = null;
	let sessionCount = 0;
	let failures = 0;
	let latestTrade: MarketTrade | null = null;

	function remember(trades: readonly MarketTrade[]) {
		for (const t of trades) {
			if (!latestTrade || compareMarketTrades(t, latestTrade) > 0) {
				latestTrade = t;
			}
		}
	}

	function save(candles: Candle[]) {
		if (candles.length === 0) return;
		try {
			repo.upsertCollected(candles);
			repo.refillDerived(
				(candles[0] as Candle).time,
				(candles.at(-1) as Candle).time + 1,
				null,
				{ overrideImported: true },
			);
		} catch (e) {
			console.error("collector: failed to save candles", e);
		}
	}

	async function backfill(id: number, readyAt: number) {
		let recent: MarketTrade[] = [];
		try {
			recent = await feed.recentTrades();
		} catch (e) {
			// 補えなくても、購読が始まった後の約定から足を作れる
			console.error("collector: failed to fetch recent trades", e);
		}
		const s = session;
		if (!s || s.id !== id) return;
		const oldest = [...recent].sort(compareMarketTrades)[0];
		// 直近の約定は、最も古いものより後を漏れなく含む。ただし取引所の時刻は秒単位なので、
		// 最も古い約定が分のちょうど始まりだと、同じ秒のより前の約定を取りこぼしてその分が欠けうる
		const coveredFrom =
			oldest === undefined
				? readyAt
				: Math.min(
						oldest.time % 60_000 === 0 ? oldest.time + 1 : oldest.time,
						readyAt,
					);
		let candles = startMinuteCandles(coveredFrom);
		for (const t of [...recent, ...s.buffer]) {
			candles = addTrade(candles, t);
		}
		remember(recent);
		s.candles = candles;
		s.buffer = [];
		s.runningSince = now();
		status = {
			state: "running",
			stoppedSince: null,
			error: null,
			retryAt: null,
			lastReceivedAt: status.lastReceivedAt,
		};
	}

	function connect() {
		const id = ++sessionCount;
		const s: NonNullable<typeof session> = {
			id,
			conn: null,
			startedAt: now(),
			runningSince: null,
			buffer: [],
			candles: null,
		};
		session = s;
		status = { ...status, state: "connecting", retryAt: null };
		const current = () => session?.id === id;
		try {
			s.conn = feed.connect({
				onReady() {
					if (current()) void backfill(id, now());
				},
				onTrades(trades) {
					if (!current()) return;
					remember(trades);
					try {
						onTrades?.(trades);
					} catch (e) {
						console.error("collector: onTrades failed", e);
					}
					if (s.candles) {
						for (const t of trades) s.candles = addTrade(s.candles, t);
					} else {
						s.buffer.push(...trades);
					}
				},
				onMessage() {
					if (current()) status = { ...status, lastReceivedAt: now() };
				},
				onClose(reason) {
					if (current()) fail(reason);
				},
			});
		} catch (e) {
			fail(`接続できない: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	function fail(reason: string) {
		const s = session;
		session = null;
		s?.conn?.close();
		const t = now();
		if (s?.runningSince != null && t - s.runningSince >= STABLE_MS) {
			failures = 0;
		}
		failures++;
		const delay = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
		status = {
			state: "stopped",
			stoppedSince: status.stoppedSince ?? t,
			error: reason,
			retryAt: t + delay,
			lastReceivedAt: status.lastReceivedAt,
		};
	}

	connect();

	return {
		tick() {
			const t = now();
			if (status.state === "stopped") {
				if (status.retryAt !== null && t >= status.retryAt) connect();
				return;
			}
			const s = session;
			if (!s) return;
			if (!s.candles) {
				if (t - s.startedAt > connectTimeoutMs) {
					fail("取引所へ接続できない（応答が無い）");
				}
				return;
			}
			const last = status.lastReceivedAt ?? s.startedAt;
			if (t - last > silenceMs) {
				fail(`取引所から${Math.round(silenceMs / 1000)}秒以上なにも届かない`);
				return;
			}
			// 受け取った時刻までしか確定しない。接続が黙って死んでいる間に、横ばいの足を作らないため
			const r = closeMinutes(s.candles, last, graceMs);
			s.candles = r.state;
			save(r.candles);
		},

		live() {
			const t = now();
			const state = session?.candles ?? null;
			const unsaved: Candle[] = [];
			if (state) {
				for (
					let m = state.nextMinute;
					m < candleStart(t, "1m");
					m += TIMEFRAME_MS["1m"]
				) {
					const c = formingCandle(state, m);
					if (c) unsaved.push(c);
				}
			}
			return {
				latestTrade,
				forming: state ? formingCandle(state, t) : null,
				unsaved,
				status,
			};
		},

		stop() {
			const s = session;
			session = null;
			s?.conn?.close();
		},
	};
}
