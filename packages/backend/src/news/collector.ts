// ニュース収集の常駐処理。設定された間隔で、有効な取得元の RSS を順に取得して保存する

import type { NewsRepository } from "./repository";
import { parseFeed } from "./rss";

/** RSS を取得する手段。テストと E2E では偽物に差し替える */
export type FetchFeed = (url: string) => Promise<string>;

export const DEFAULT_INTERVAL_MINUTES = 15;
const FETCH_TIMEOUT_MS = 20_000;

export const httpFetchFeed: FetchFeed = async (url) => {
	const res = await fetch(url, {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		headers: { "user-agent": "trading-studio (personal use)" },
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.text();
};

export type NewsCollector = {
	/** 定期的に呼ぶ（main では1秒ごと）。次の収集の時刻を過ぎていれば収集を始める */
	tick(): void;
	/** 収集を1回行う。すでに動いていれば、その回の終わりを待つ */
	run(): Promise<void>;
	/** 動いている収集の終わりを待つ（テスト用） */
	idle(): Promise<void>;
	lastRunAt(): number | null;
	nextRunAt(): number | null;
};

export function createNewsCollector({
	repo,
	fetchFeed,
	now = Date.now,
}: {
	repo: NewsRepository;
	fetchFeed: FetchFeed;
	now?: () => number;
}): NewsCollector {
	let lastRunAt: number | null = null;
	let running: Promise<void> | null = null;

	// 間隔は毎回読み直す（設定の変更を再起動なしで次の収集から反映するため）
	const nextRunAt = () =>
		lastRunAt === null
			? null
			: lastRunAt + repo.intervalMinutes(DEFAULT_INTERVAL_MINUTES) * 60_000;

	async function runOnce() {
		lastRunAt = now();
		for (const source of repo.listSources()) {
			if (!source.enabled) continue;
			try {
				const items = parseFeed(await fetchFeed(source.url));
				// 取得中に無効化・削除されていたら保存しない
				const current = repo.getSource(source.id);
				if (!current?.enabled) continue;
				repo.saveFetched(current, items, now());
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				if (repo.getSource(source.id)?.enabled) {
					repo.recordFailure(source.id, `取得できない: ${message}`, now());
				}
			}
		}
	}

	const collector: NewsCollector = {
		tick() {
			if (running) return;
			const next = nextRunAt();
			// 追加したばかりの取得元は、次の収集を待たずに取りに行く
			const fresh = repo
				.listSources()
				.some(
					(s) => s.enabled && s.lastSuccessAt === null && s.lastError === null,
				);
			if (next === null || now() >= next || fresh) void collector.run();
		},
		run() {
			if (!running) {
				running = runOnce()
					.catch((e) => console.error("news: collect failed", e))
					.finally(() => {
						running = null;
					});
			}
			return running;
		},
		idle: () => running ?? Promise.resolve(),
		lastRunAt: () => lastRunAt,
		nextRunAt,
	};
	return collector;
}
