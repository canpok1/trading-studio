import type { CalendarRange, ScheduledEvent } from "@trading-studio/core";
import type { EventJudgeResponse } from "./prompt-domain";
import type {
	EventCriteriaVersion,
	EventSource,
	EventSourceInput,
	JudgmentCoverage,
} from "./types-domain";

/** iCal の予定1件 */
export type IcalEvent = {
	/** iCal の UID。無ければ null */
	uid: string | null;
	summary: string;
	description: string | null;
	/** 開始時刻。終日の予定は、JST のその日の 0:00 */
	start: number;
	allDay: boolean;
};

/** 保存する予定1件 */
export type EventRow = {
	uid: string;
	title: string;
	description: string | null;
	start: number;
	end: number;
	allDay: boolean;
};

/** 取得元の行 */
export type EventSourceRow = EventSource;

/** 重要度を判断する予定 */
export type JudgeTarget = {
	eventId: number;
	criteriaVersion: number;
	/** これまでに失敗した回数 */
	attempts: number;
	/** 取得元の名前。アプリが持つ予定は null */
	sourceName: string | null;
	title: string;
	description: string | null;
	start: number;
	allDay: boolean;
};

export interface CalendarRepository {
	listSources(): EventSourceRow[];
	getSource(id: number): EventSourceRow | null;
	sourceByUrl(url: string): EventSourceRow | null;
	insertSource(input: EventSourceInput, createdAt: number): EventSourceRow;
	/** URL が変わったら、その取得元の予定と取得の記録を消す */
	updateSource(id: number, input: EventSourceInput): void;
	removeSource(id: number): boolean;
	/**
	 * 取得した予定を保存する。同じ UID の予定は書き換え（件名か説明が変われば判断を消す）、
	 * listed に始まる予定のうち events に無いものは消し（予定の移動・取り消しを反映するため）、range をそろっている期間に足す
	 */
	saveFetched(
		sourceId: number,
		events: readonly EventRow[],
		range: CalendarRange,
		listed: CalendarRange,
		at: number,
	): void;
	recordFailure(sourceId: number, error: string, at: number): void;
	/** アプリが持つ予定のうち、まだ保存していないものを足す */
	seedBundled(events: readonly EventRow[]): void;
	/** 取得した予定がそろっている期間（取得元ごとにまとめたもの） */
	coverage(): CalendarRange[];

	/** 版が1つも無ければ初版を入れて使用中にする */
	seedCriteria(text: string, now: number): void;
	listCriteria(): EventCriteriaVersion[];
	getCriteria(version: number): EventCriteriaVersion | null;
	addCriteria(text: string, note: string, now: number): EventCriteriaVersion;
	activeCriteriaVersion(): number | null;
	setActiveCriteria(version: number): void;

	/** 予定（時刻の順）。importance は version で判断済みのもの */
	events(version: number | null): ScheduledEvent[];
	/**
	 * version で判断していない（再試行の時刻が来たもの・失敗して止めたあと判断し直す時刻が来たものを含む）予定のうち、
	 * range に掛かる（終わりが from 以降・始まりが until より前）次の1件。order は始まりの順
	 */
	nextUnjudged(
		version: number,
		range: CalendarRange,
		order: "asc" | "desc",
		now: number,
	): JudgeTarget | null;
	/** 頼まれた判断（使用中でない版を含む）のうち次のもの。頼んだ順、同じ頼みの中は予定の早い順 */
	nextRequested(now: number): JudgeTarget | null;
	/** 判断した予定の件名が判断の間に変わったか、予定が消えていれば何もしない（古い中身での判断を残さないため） */
	saveJudgment(
		target: JudgeTarget,
		r: EventJudgeResponse,
		meta: {
			judgedAt: number;
			model: string;
			appBuiltAt: number | null;
			attempts: number;
		},
	): void;
	/**
	 * 失敗を記録する。stopped なら「失敗」にする（バックテストは除いて実行できる）。
	 * どちらも nextAttemptAt に判断し直す。saveJudgment と同じく、件名が変わったか予定が消えていれば何もしない
	 */
	saveJudgmentFailure(
		target: JudgeTarget,
		error: string,
		attempts: number,
		stopped: boolean,
		nextAttemptAt: number,
		now: number,
	): void;
	/** [from, to] に掛かる予定の、version での判断の件数 */
	judgmentCoverage(from: number, to: number, version: number): JudgmentCoverage;
	/** [from, to] に掛かる予定のうち、version で判断していないもの・失敗したものの判断を頼む */
	requestJudgments(
		from: number,
		to: number,
		version: number,
		now: number,
	): void;
	/** version で判断済み（失敗して止めたものを含む）でない予定の件数 */
	unjudgedCount(version: number): number;
	/** version で判断に失敗して止めた予定の件数 */
	failedCount(version: number): number;
}
