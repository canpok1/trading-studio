import type {
	CalendarRange,
	MarketEvent,
	ScheduledEvent,
} from "@trading-studio/core";
import type { EventSource, EventSourceInput } from "./types-domain";

/** iCal の予定1件 */
export type IcalEvent = {
	summary: string;
	/** 開始時刻。終日の予定は、その日の 0:00（時差の指定が無ければ UTC） */
	start: number;
	allDay: boolean;
};

/** 取得元の行。stale は保存した暦から求めるので持たない */
export type EventSourceRow = Omit<EventSource, "stale"> & {
	/** 最初に取得できた時刻。URL か語を変えたら null に戻す */
	firstSuccessAt: number | null;
};

export interface CalendarRepository {
	listSources(): EventSourceRow[];
	getSource(id: number): EventSourceRow | null;
	sourceByUrl(url: string): EventSourceRow | null;
	insertSource(input: EventSourceInput, createdAt: number): EventSourceRow;
	/** URL か語が変わったら、その取得元の暦と取得の記録を消す */
	updateSource(id: number, input: EventSourceInput): void;
	removeSource(id: number): boolean;
	/**
	 * 取得した暦を保存する。types の暦のうち listed に始まるものを events で置き換え（予定の移動・取り消しを反映するため）、
	 * range をそろっている期間に足す
	 */
	saveFetched(
		sourceId: number,
		types: readonly MarketEvent[],
		events: readonly ScheduledEvent[],
		range: CalendarRange,
		listed: CalendarRange,
		at: number,
	): void;
	recordFailure(sourceId: number, error: string, at: number): void;
	/** 取得した暦（時刻の順） */
	events(): ScheduledEvent[];
	/** 取得した暦がそろっている期間（取得元ごとにまとめたもの） */
	coverage(): { type: MarketEvent; range: CalendarRange }[];
	/** 取得元ごと・種類ごとの、最後に始まるイベントの時刻 */
	lastEventAt(): { sourceId: number; type: MarketEvent; start: number }[];
}
