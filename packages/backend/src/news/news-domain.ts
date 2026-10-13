import type { AggregationRule, Duration } from "@trading-studio/core";
import { DURATIONS } from "@trading-studio/core";
import type { NewsCollector } from "./collector-domain";
import { DEFAULT_INTERVAL_MINUTES } from "./collector-domain";
import type { NewsRepository } from "./repository-domain";
import type {
	NewsCollectorStatus,
	NewsFilter,
	NewsImpact,
	NewsItem,
	NewsService,
	NewsSort,
	NewsSourceInput,
	NewsSourceResult,
} from "./types-domain";
import {
	NEWS_IMPACTS,
	NEWS_LANGUAGES,
	NEWS_LIST_MAX,
	NEWS_SORTS,
} from "./types-domain";

/** キーワードの長さの上限 */
const MAX_Q = 200;

/** 一覧の条件を読む。形が違えばその理由 */
export function parseFilter(
	q: Record<string, string | undefined>,
): NewsFilter | string {
	const limit = Math.min(
		NEWS_LIST_MAX,
		Math.max(1, Math.floor(Number(q.limit ?? 100)) || 100),
	);
	const time = (v: string | undefined) =>
		v === undefined || v === "" ? null : Number(v);
	const from = time(q.from);
	const to = time(q.to);
	if (
		(from !== null && !Number.isSafeInteger(from)) ||
		(to !== null && !Number.isSafeInteger(to))
	) {
		return "期間の形が違う";
	}
	const impacts = q.impact ? q.impact.split(",") : [];
	if (!impacts.every((i) => (NEWS_IMPACTS as readonly string[]).includes(i))) {
		return "影響の大きさの形が違う";
	}
	const durations = q.duration ? q.duration.split(",") : [];
	if (!durations.every((d) => (DURATIONS as readonly string[]).includes(d))) {
		return "持続の形が違う";
	}
	const activeAt = time(q.active);
	if (activeAt !== null && !Number.isSafeInteger(activeAt)) {
		return "評価の時刻の形が違う";
	}
	const sort = q.sort ?? "new";
	if (!(NEWS_SORTS as readonly string[]).includes(sort)) {
		return "並び順の形が違う";
	}
	const text = (q.q ?? "").trim();
	if (text.length > MAX_Q) return `キーワードは${MAX_Q}文字まで`;
	return {
		limit,
		from,
		to,
		q: text,
		impacts: impacts as NewsImpact[],
		durations: durations as Duration[],
		activeAt,
		sort: sort as NewsSort,
	};
}

/** 既定の取得元（docs/adr/0008） */
export const DEFAULT_NEWS_SOURCES: readonly NewsSourceInput[] = [
	{
		name: "NADA NEWS",
		url: "https://www.coindeskjapan.com/feed/",
		language: "ja",
	},
	{
		name: "あたらしい経済",
		url: "https://www.neweconomy.jp/feed",
		language: "ja",
	},
	{
		name: "NHK 経済",
		url: "https://news.web.nhk/n-data/conf/na/rss/cat5.xml",
		language: "ja",
	},
];

export const INTERVAL_LIMITS = { min: 5, max: 1440 } as const;
const NAME_MAX = 40;

function checkName(name: string): string | null {
	const n = name.trim();
	if (!n) return "名前を入れる";
	if (n.length > NAME_MAX) return `${NAME_MAX} 文字以内にする`;
	return null;
}

function checkUrl(url: string): string | null {
	try {
		const u = new URL(url.trim());
		return u.protocol === "http:" || u.protocol === "https:"
			? null
			: "http または https の URL を入れる";
	} catch {
		return "URL の形が違う";
	}
}

export function createNewsService({
	repo,
	collector,
	rule,
	rescoring = () => null,
	now = Date.now,
}: {
	repo: NewsRepository;
	collector: Pick<NewsCollector, "lastRunAt" | "nextRunAt">;
	/** 影響の大きさで絞るときの評価基準（今の評価ルール） */
	rule: () => AggregationRule;
	/** いま採点し直している記事と版（Scorer.rescoring） */
	rescoring?: () => { newsId: number; version: number } | null;
	now?: () => number;
}): NewsService {
	/** 順番待ちのうち、いま採点し直しているものを採点し直し中にする */
	const withRunning = (items: NewsItem[]): NewsItem[] => {
		const cur = rescoring();
		if (!cur) return items;
		return items.map((n) =>
			n.id === cur.newsId &&
			n.rescore?.version === cur.version &&
			n.rescore.status === "waiting"
				? { ...n, rescore: { ...n.rescore, status: "running", ahead: null } }
				: n,
		);
	};

	const found = (id: number): NewsSourceResult => {
		const source = repo.getSource(id);
		return source ? { ok: true, source } : { ok: false, kind: "not_found" };
	};

	return {
		listSources: () => repo.listSources(),

		addSource(input) {
			const nameError = checkName(input.name);
			if (nameError)
				return {
					ok: false,
					kind: "invalid",
					field: "name",
					message: nameError,
				};
			const urlError = checkUrl(input.url);
			if (urlError)
				return { ok: false, kind: "invalid", field: "url", message: urlError };
			if (!NEWS_LANGUAGES.includes(input.language)) {
				return {
					ok: false,
					kind: "invalid",
					field: "language",
					message: "言語を選ぶ",
				};
			}
			const url = input.url.trim();
			if (repo.sourceByUrl(url)) {
				return {
					ok: false,
					kind: "duplicate_url",
					message: "同じ URL の取得元がある",
				};
			}
			return {
				ok: true,
				source: repo.insertSource(
					{ name: input.name.trim(), url, language: input.language },
					now(),
				),
			};
		},

		updateSource(id, patch) {
			if (!repo.getSource(id)) return { ok: false, kind: "not_found" };
			if (patch.name !== undefined) {
				const nameError = checkName(patch.name);
				if (nameError)
					return {
						ok: false,
						kind: "invalid",
						field: "name",
						message: nameError,
					};
			}
			repo.updateSource(id, { ...patch, name: patch.name?.trim() });
			return found(id);
		},

		removeSource: (id) => repo.removeSource(id),

		intervalMinutes: () => repo.intervalMinutes(DEFAULT_INTERVAL_MINUTES),

		setIntervalMinutes(minutes) {
			const { min, max } = INTERVAL_LIMITS;
			if (!Number.isInteger(minutes) || minutes < min || minutes > max) {
				return { ok: false, message: `${min}〜${max} 分の整数で入れる` };
			}
			repo.setIntervalMinutes(minutes);
			return { ok: true };
		},

		status(): NewsCollectorStatus {
			const sources = repo.listSources();
			const enabled = sources.filter((s) => s.enabled);
			const failing = enabled.filter((s) => s.lastError !== null);
			let error: string | null = null;
			let stoppedSince: number | null = null;
			if (enabled.length === 0) {
				error = "有効な取得元が無い";
			} else if (failing.length === enabled.length) {
				error = "すべての取得元で取得に失敗している";
				stoppedSince = Math.min(...failing.map((s) => s.errorSince ?? now()));
			}
			return {
				state: error ? "stopped" : "running",
				error,
				stoppedSince,
				intervalMinutes: repo.intervalMinutes(DEFAULT_INTERVAL_MINUTES),
				lastRunAt: collector.lastRunAt(),
				nextRunAt: collector.nextRunAt(),
				sources,
			};
		},

		listNews: (limit) => withRunning(repo.listNews(limit)),
		searchNews(filter) {
			const r = repo.searchNews(filter, rule());
			return { ...r, news: withRunning(r.news) };
		},
	};
}
