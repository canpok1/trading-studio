import type { AggregationRule } from "@trading-studio/core";
import type {
	NewsFilter,
	NewsItem,
	NewsSearchResult,
	NewsSource,
	NewsSourceInput,
} from "./types-domain";

export type FeedItem = {
	title: string;
	url: string;
	/** 概要。無ければ null */
	summary: string | null;
	/** 公開時刻。無いか読めなければ null */
	publishedAt: number | null;
};

export interface NewsRepository {
	listSources(): NewsSource[];
	getSource(id: number): NewsSource | null;
	sourceByUrl(url: string): NewsSource | null;
	insertSource(input: NewsSourceInput, createdAt: number): NewsSource;
	updateSource(
		id: number,
		patch: {
			enabled?: boolean;
			name?: string;
		},
	): void;
	removeSource(id: number): boolean;
	/** 既定の取得元を1度だけ入れる。利用者が消した取得元を起動のたびに戻さないため、入れたことを覚えておく */
	seedSources(defaults: readonly NewsSourceInput[], now: number): void;
	intervalMinutes(fallback: number): number;
	setIntervalMinutes(minutes: number): void;
	/** 取得できた記事を保存する。同じ URL の記事は保存しない。保存した件数を返す */
	saveFetched(
		source: NewsSource,
		items: readonly FeedItem[],
		fetchedAt: number,
	): number;
	recordFailure(sourceId: number, error: string, at: number): void;
	listNews(limit: number): NewsItem[];
	/** 条件で絞る。影響の大きさは rule の評価基準で測る */
	searchNews(f: NewsFilter, rule: AggregationRule): NewsSearchResult;
	/** ID で引く。無い ID は飛ばす。並びは ids の順 */
	newsByIds(ids: readonly number[]): NewsItem[];
}
