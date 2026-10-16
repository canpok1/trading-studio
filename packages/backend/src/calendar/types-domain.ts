import type { EventCalendar, EventImportance } from "@trading-studio/core";

/** 予定の取得元（iCal） */
export type EventSource = {
	id: number;
	name: string;
	url: string;
	createdAt: number;
	lastSuccessAt: number | null;
	/** 直近の取得の失敗理由。成功したら null */
	lastError: string | null;
	/** 失敗が続いている最初の時刻 */
	errorSince: number | null;
};

export type EventSourceInput = { name: string; url: string };

export type EventSourceResult =
	| { ok: true; source: EventSource }
	| { ok: false; kind: "not_found" }
	| { ok: false; kind: "invalid"; field: string; message: string }
	| { ok: false; kind: "duplicate_url"; message: string };

/** 予定の評価基準の版 */
export type EventCriteriaVersion = {
	version: number;
	text: string;
	note: string;
	createdAt: number;
};

export type EventCriteria = {
	versions: EventCriteriaVersion[];
	activeVersion: number | null;
	/** 固定のひな形。{event} に予定、{criteria} に評価基準が入る */
	template: string;
};

export type CalendarStatus = {
	/** 今の時刻から暦がそろっている終わり。今の時刻の暦が無ければ null */
	coveredUntil: number | null;
	lastRunAt: number | null;
	nextRunAt: number | null;
	/** 使用中の版で重要度をまだ判断していない予定の件数（再試行待ちを含む） */
	unjudged: number;
	/** 使用中の版で判断に失敗して止めた予定の件数。1時間ごとに判断し直す */
	failed: number;
};

/** 期間の予定のうち、ある版で重要度を判断済みのものの件数 */
export type JudgmentCoverage = {
	total: number;
	done: number;
	/** 判断を頼んで待っているか、再試行を待っている */
	pending: number;
	/** 判断に失敗して止めた */
	failed: number;
};

/** 予定1件の重要度の判断 */
export type EventJudgment =
	| {
			status: "pending" | "retry";
			attempts: number;
			error: string | null;
			/** 再試行の時刻。すぐ判断するなら null */
			nextAttemptAt: number | null;
	  }
	| { status: "failed"; attempts: number; error: string }
	| {
			status: "done";
			importance: EventImportance;
			reason: string;
			judgedAt: number;
			model: string;
	  };

/** 一覧に出す予定1件 */
export type ListedEvent = {
	id: number;
	title: string;
	description: string | null;
	start: number;
	end: number;
	allDay: boolean;
	/** 取得元の名前。アプリが持つ予定は null */
	sourceName: string | null;
	/** その版での判断。まだ判断していなければ null */
	judgment: EventJudgment | null;
};

/** 一覧で一度に返す件数の上限 */
export const EVENT_LIST_MAX = 500;

export type EventListResult = {
	version: number;
	events: ListedEvent[];
	/** 条件に合う件数（上限を超えた分を含む） */
	total: number;
};

export type EventCriteriaResult =
	| { ok: true; version: EventCriteriaVersion }
	| { ok: false; message: string };

export interface CalendarService {
	listSources(): EventSource[];
	addSource(input: EventSourceInput): EventSourceResult;
	/** URL を変えたら、その取得元から取得した予定を消して取り直す */
	updateSource(id: number, input: EventSourceInput): EventSourceResult;
	/** 取得元と、そこから取得した予定を消す */
	removeSource(id: number): boolean;
	status(): CalendarStatus;
	criteria(): EventCriteria;
	addCriteria(text: string, note: string): EventCriteriaResult;
	setActiveCriteria(version: number): boolean;
	/** 判定に使う暦。version を省くと使用中の版の重要度 */
	calendar(version?: number): EventCalendar;
	/** 使用中の版。版が無ければ null */
	activeVersion(): number | null;
	/** バックテストの期間 [from, to] の判定で見る予定のうち、version で判断済みのものの件数。版が無ければ null */
	judgmentCoverage(
		from: number,
		to: number,
		version: number,
	): JudgmentCoverage | null;
	/** judgmentCoverage と同じ予定のうち、version で判断していないもの・失敗したものの判断を頼む */
	requestJudgments(
		from: number,
		to: number,
		version: number,
	): JudgmentCoverage | null;
	/**
	 * [from, to] に掛かる予定を始まりの順に。version を省くと使用中の版。
	 * minImportance を指定すると、判断済みでそれより低い予定を除く（判断していない予定は残す）。版が無ければ null
	 */
	listEvents(query: {
		from: number;
		to: number;
		version?: number;
		minImportance?: EventImportance;
	}): EventListResult | null;
	/**
	 * 判断に失敗して止めた予定1件を、その版（省くと使用中の版）で判断し直すよう頼む。予定・版が無いか失敗していなければ false。
	 * 判断済みの予定は頼めない（頼み直す間に元の判断を消すと、運用の判定が暦切れになるため）
	 */
	rejudgeEvent(id: number, version?: number): boolean;
}
