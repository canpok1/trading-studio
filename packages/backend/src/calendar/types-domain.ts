import type { EventCalendar, MarketEvent } from "@trading-studio/core";

/** 予定イベントの種類ごとの、iCal の件名で拾う語。語の無い種類はこの取得元から拾わない */
export type EventKeywords = Partial<Record<MarketEvent, string>>;

/** 予定イベントの暦の取得元（iCal） */
export type EventSource = {
	id: number;
	name: string;
	url: string;
	keywords: EventKeywords;
	createdAt: number;
	lastSuccessAt: number | null;
	/** 直近の取得の失敗理由。成功したら null */
	lastError: string | null;
	/** 失敗が続いている最初の時刻 */
	errorSince: number | null;
	/** 語を入れた種類のうち、長く1件も拾えていないもの（件名が変わって拾えなくなった疑い） */
	stale: MarketEvent[];
};

export type EventSourceInput = {
	name: string;
	url: string;
	keywords: EventKeywords;
};

export type EventSourceResult =
	| { ok: true; source: EventSource }
	| { ok: false; kind: "not_found" }
	| { ok: false; kind: "invalid"; field: string; message: string }
	| { ok: false; kind: "duplicate_url"; message: string };

export type CalendarStatus = {
	/** 種類ごとの、今の時刻から暦がそろっている終わり。今の時刻の暦が無ければ null */
	coveredUntil: { type: MarketEvent; until: number | null }[];
	lastRunAt: number | null;
	nextRunAt: number | null;
};

export interface CalendarService {
	listSources(): EventSource[];
	addSource(input: EventSourceInput): EventSourceResult;
	/** URL か語を変えたら、その取得元から取得した暦を消して取り直す */
	updateSource(id: number, input: EventSourceInput): EventSourceResult;
	/** 取得元と、そこから取得した暦を消す */
	removeSource(id: number): boolean;
	status(): CalendarStatus;
	/** 判定に使う暦。リポジトリに持つ暦と取得した暦を合わせたもの */
	calendar(): EventCalendar;
}
