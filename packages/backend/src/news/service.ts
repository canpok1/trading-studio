import type { NewsCollector } from "./collector";
import { DEFAULT_INTERVAL_MINUTES } from "./collector";
import type { NewsRepository } from "./repository";
import type {
	NewsCollectorStatus,
	NewsService,
	NewsSourceInput,
	NewsSourceResult,
} from "./types";
import { NEWS_LANGUAGES } from "./types";

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
	now = Date.now,
}: {
	repo: NewsRepository;
	collector: Pick<NewsCollector, "lastRunAt" | "nextRunAt">;
	now?: () => number;
}): NewsService {
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

		listNews: (limit) => repo.listNews(limit),
	};
}
