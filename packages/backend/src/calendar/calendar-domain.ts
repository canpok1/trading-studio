// 予定の取得（設定の取得元の iCal を定期的に取って保存する）・AI による重要度の判断・判定に使う暦の組み立て

import type { CalendarRange, EventCalendar } from "@trading-studio/core";
import { mergeRanges } from "@trading-studio/core";
import type { AiJob, AiJobSource } from "../ai/job-domain";
import { RETRY_DELAYS_MS } from "../news/scorer-domain";
import { BUNDLED_EVENTS, BUNDLED_RANGE } from "./bundled-domain";
import {
	buildEventPrompt,
	DEFAULT_EVENT_CRITERIA,
	EVENT_PROMPT_TEMPLATE,
	EVENT_RESPONSE_SCHEMA,
	parseEventResponse,
} from "./prompt-domain";
import type {
	CalendarRepository,
	EventRow,
	EventSourceRow,
	IcalEvent,
	JudgeTarget,
} from "./repository-domain";
import type {
	CalendarService,
	EventSourceInput,
	EventSourceResult,
} from "./types-domain";

/** 取得元の予定を取る手段。テストでは偽物に差し替える */
export type FetchIcal = (url: string) => Promise<IcalEvent[]>;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const FETCH_INTERVAL_MS = 6 * HOUR_MS;
/**
 * 前回の取得からこの時間までなら、その間の暦もそろっているとみなす。
 * 今週の分だけを載せる取得元では、週の変わり目の前後がどちらの取得にも載らないため
 */
const CONTINUOUS_MS = DAY_MS;
/** 運用で使う予定として先に判断する範囲。予定の前後の条件で見る一番長い時間（168 時間）だけ前に終わった予定から */
const LIVE_LOOKBACK_MS = 7 * DAY_MS;
/** 同じく、これから始まる予定はこの時間先まで（168 時間に、判断が済むまでの余裕を足す） */
const LIVE_AHEAD_MS = 8 * DAY_MS;
/** 再試行の回数を超えて失敗した予定を、使用中の版で判断し直すまでの間。AI が長く止まっても、戻れば判断が進むように */
const FAILED_RETRY_MS = HOUR_MS;
const ALL: CalendarRange = {
	from: Number.MIN_SAFE_INTEGER,
	until: Number.MAX_SAFE_INTEGER,
};
const NAME_MAX = 40;
const CRITERIA_MAX = 5000;
const NOTE_MAX = 100;
/** アプリが持つ予定の取得元の名前（AI に渡す） */
const BUNDLED_SOURCE_NAME = "アプリが持つ過去の予定";

/** 取得元の入力を読む。形が違えば null */
export function parseEventSourceInput(v: unknown): EventSourceInput | null {
	if (typeof v !== "object" || v === null) return null;
	const { name, url } = v as Record<string, unknown>;
	if (typeof name !== "string" || typeof url !== "string") return null;
	return { name, url };
}

function checkInput(
	input: EventSourceInput,
): { field: string; message: string } | null {
	const name = input.name.trim();
	if (!name) return { field: "name", message: "名前を入れる" };
	if (name.length > NAME_MAX)
		return { field: "name", message: `${NAME_MAX} 文字以内にする` };
	try {
		const u = new URL(normalizeUrl(input.url));
		if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
	} catch {
		return { field: "url", message: "http(s) の URL を入れる" };
	}
	return null;
}

/** 購読用の webcal:// は https:// で取る */
const normalizeUrl = (url: string) =>
	url.trim().replace(/^webcals?:\/\//i, "https://");

/** 取得元の予定を取得した時刻の前後この範囲だけ、そろっている期間に数える（繰り返しの予定や遠い過去・先の予定で期間が広がりすぎないように） */
const LISTED_BEFORE_MS = 7 * DAY_MS;
const LISTED_AFTER_MS = 366 * DAY_MS;

/**
 * 取得した予定を保存する形にする。終日の予定はその日の 24 時間を予定の時間にする。
 * そろっている期間は、載っている最初の予定（取得した時刻の LISTED_BEFORE_MS 前まで）から、
 * 最後の予定（同じく LISTED_AFTER_MS 後まで）か次の取得の予定時刻の遅いほうまで。
 * 前回の取得が CONTINUOUS_MS 以内なら、その時刻からそろっているとみなす
 */
export function toCalendar(
	items: readonly IcalEvent[],
	fetchedAt: number,
	prevSuccessAt: number | null,
): {
	events: EventRow[];
	range: CalendarRange;
	/** 取得元の今の中身で置き換える期間 */
	listed: CalendarRange;
} {
	const events: EventRow[] = items.map((i) => ({
		// UID の無い予定は件名と時刻で見分ける（時刻が変わると別の予定になる）
		uid: i.uid ?? `${i.summary}@${i.start}`,
		title: i.summary,
		description: i.description,
		start: i.start,
		end: i.allDay ? i.start + DAY_MS : i.start,
		allDay: i.allDay,
	}));
	const starts = items
		.map((i) => i.start)
		.filter(
			(t) =>
				t >= fetchedAt - LISTED_BEFORE_MS && t <= fetchedAt + LISTED_AFTER_MS,
		);
	const first = Math.min(fetchedAt, ...starts);
	const last = Math.max(fetchedAt, ...starts);
	// 取得した時刻より後で載っていない予定は、移動か取り消しとみなす。前の予定は今週の分だけを載せる取得元で消えるので残す
	const listed = { from: fetchedAt, until: last + 1 };
	const continuous =
		prevSuccessAt !== null && fetchedAt - prevSuccessAt <= CONTINUOUS_MS;
	const range = {
		from: continuous ? (prevSuccessAt as number) : first,
		// 次の取得までに載る予定は、次の取得で拾う。今週の分だけを載せる取得元で、週の最後の予定の後が暦切れにならないように
		until: Math.max(last + 1, fetchedAt + FETCH_INTERVAL_MS),
	};
	return { events, range, listed };
}

export type CalendarCollector = CalendarService & {
	/** 定期的に呼ぶ（main では1分ごと）。次の取得の時刻を過ぎていれば取得を始める */
	tick(): void;
	/** 取得を1回行う。すでに動いていれば、その回の終わりを待つ */
	run(): Promise<void>;
	/** 重要度の判断。ニュースの採点の常駐処理が、採点の合間に進める */
	jobs: AiJobSource;
};

export function createCalendarService({
	repo,
	fetchIcal,
	appBuiltAt = null,
	now = Date.now,
	retryDelaysMs = RETRY_DELAYS_MS,
}: {
	repo: CalendarRepository;
	fetchIcal: FetchIcal;
	/** 動いているアプリのバージョン（ビルド日時）。判断ごとに記録する。開発版は null */
	appBuiltAt?: number | null;
	now?: () => number;
	/** 判断の自動の再試行の間隔。回数はこの長さ */
	retryDelaysMs?: readonly number[];
}): CalendarCollector {
	repo.seedBundled(BUNDLED_EVENTS.map((e) => ({ ...e, description: null })));
	repo.seedCriteria(DEFAULT_EVENT_CRITERIA, now());

	let lastRunAt: number | null = null;
	let running: Promise<void> | null = null;
	const cached = new Map<number | null, EventCalendar>();
	const invalidate = () => cached.clear();

	const nextRunAt = () =>
		lastRunAt === null ? null : lastRunAt + FETCH_INTERVAL_MS;

	async function fetchOne(source: EventSourceRow) {
		try {
			const items = await fetchIcal(source.url);
			// 取得中に消されたか、URL が変わっていたら保存しない
			const current = repo.getSource(source.id);
			if (!current || current.url !== source.url) return;
			if (items.length === 0) throw new Error("予定が1件も無い");
			const at = now();
			const c = toCalendar(items, at, current.lastSuccessAt);
			repo.saveFetched(current.id, c.events, c.range, c.listed, at);
			invalidate();
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			if (repo.getSource(source.id)) {
				repo.recordFailure(source.id, `取得できない: ${message}`, now());
			}
		}
	}

	async function runOnce() {
		lastRunAt = now();
		for (const source of repo.listSources()) await fetchOne(source);
	}

	function calendar(version?: number): EventCalendar {
		const v = version ?? repo.activeCriteriaVersion();
		const hit = cached.get(v);
		if (hit) return hit;
		const cal = {
			events: repo.events(v),
			covered: mergeRanges([BUNDLED_RANGE, ...repo.coverage()]),
		};
		cached.set(v, cal);
		return cal;
	}

	function save(input: EventSourceInput, id: number | null): EventSourceResult {
		const bad = checkInput(input);
		if (bad) return { ok: false, kind: "invalid", ...bad };
		const v = { name: input.name.trim(), url: normalizeUrl(input.url) };
		const same = repo.sourceByUrl(v.url);
		if (same && same.id !== id) {
			return {
				ok: false,
				kind: "duplicate_url",
				message: "同じ URL の取得元がある",
			};
		}
		if (id === null) {
			return { ok: true, source: repo.insertSource(v, now()) };
		}
		if (!repo.getSource(id)) return { ok: false, kind: "not_found" };
		repo.updateSource(id, v);
		invalidate();
		return { ok: true, source: repo.getSource(id) as EventSourceRow };
	}

	/** 予定1件の重要度を判断する仕事。失敗は運用のニュースの採点と同じく、間を延ばしながら再試行する */
	const judgeJob =
		(t: JudgeTarget): AiJob =>
		async (ask) => {
			const criteria = repo.getCriteria(t.criteriaVersion);
			if (!criteria) {
				repo.saveJudgmentFailure(
					t,
					"評価基準の版が無い",
					t.attempts + 1,
					true,
					now() + FAILED_RETRY_MS,
					now(),
				);
				invalidate();
				return;
			}
			try {
				const { value, model } = await ask(
					buildEventPrompt(
						{ ...t, sourceName: t.sourceName ?? BUNDLED_SOURCE_NAME },
						criteria.text,
					),
					EVENT_RESPONSE_SCHEMA,
				);
				const r = parseEventResponse(value);
				if (typeof r === "string") throw new Error(`応答の形が違う: ${r}`);
				repo.saveJudgment(t, r, {
					judgedAt: now(),
					model,
					appBuiltAt,
					attempts: t.attempts,
				});
			} catch (e) {
				const attempts = t.attempts + 1;
				const delay = retryDelaysMs[attempts - 1];
				repo.saveJudgmentFailure(
					t,
					e instanceof Error ? e.message : String(e),
					attempts,
					delay === undefined,
					now() + (delay ?? FAILED_RETRY_MS),
					now(),
				);
			} finally {
				invalidate();
			}
		};

	const jobs: AiJobSource = {
		// 使用中の版で、運用の判定で見る予定（これから来るものと直近のもの）を早い順に
		urgent(t) {
			const v = repo.activeCriteriaVersion();
			if (v === null) return null;
			const next = repo.nextUnjudged(
				v,
				{ from: t - LIVE_LOOKBACK_MS, until: t + LIVE_AHEAD_MS },
				"asc",
				t,
			);
			return next ? judgeJob(next) : null;
		},
		// 頼まれた判断を頼んだ順に、その後で使用中の版の過去の予定を新しい順に、残り（先の予定）を早い順に
		background(t) {
			const requested = repo.nextRequested(t);
			if (requested) return judgeJob(requested);
			const v = repo.activeCriteriaVersion();
			if (v === null) return null;
			const next =
				repo.nextUnjudged(
					v,
					{ from: ALL.from, until: t - LIVE_LOOKBACK_MS },
					"desc",
					t,
				) ?? repo.nextUnjudged(v, ALL, "asc", t);
			return next ? judgeJob(next) : null;
		},
	};

	const service: CalendarCollector = {
		listSources: () => repo.listSources(),
		addSource: (input) => save(input, null),
		updateSource: (id, input) => save(input, id),
		removeSource(id) {
			const ok = repo.removeSource(id);
			if (ok) invalidate();
			return ok;
		},
		status() {
			const t = now();
			const active = repo.activeCriteriaVersion();
			return {
				coveredUntil:
					calendar().covered.find((r) => r.from <= t && t < r.until)?.until ??
					null,
				lastRunAt,
				nextRunAt: nextRunAt(),
				unjudged: active === null ? 0 : repo.unjudgedCount(active),
				failed: active === null ? 0 : repo.failedCount(active),
			};
		},
		criteria: () => ({
			versions: repo.listCriteria(),
			activeVersion: repo.activeCriteriaVersion(),
			template: EVENT_PROMPT_TEMPLATE,
		}),
		addCriteria(text, note) {
			const body = text.trim();
			if (!body) return { ok: false, message: "評価基準を入れる" };
			if (body.length > CRITERIA_MAX)
				return { ok: false, message: `${CRITERIA_MAX} 文字以内にする` };
			if (repo.listCriteria().some((v) => v.text === body))
				return { ok: false, message: "同じ内容の版がある" };
			return {
				ok: true,
				version: repo.addCriteria(
					body,
					note.trim().slice(0, NOTE_MAX) || "画面から編集",
					now(),
				),
			};
		},
		setActiveCriteria(version) {
			if (!repo.getCriteria(version)) return false;
			repo.setActiveCriteria(version);
			invalidate();
			return true;
		},
		calendar,
		activeVersion: () => repo.activeCriteriaVersion(),
		judgmentCoverage(from, to, version) {
			if (!repo.getCriteria(version)) return null;
			return repo.judgmentCoverage(from, to, version);
		},
		requestJudgments(from, to, version) {
			if (!repo.getCriteria(version)) return null;
			repo.requestJudgments(from, to, version, now());
			return repo.judgmentCoverage(from, to, version);
		},
		jobs,
		tick() {
			if (running) return;
			const next = nextRunAt();
			// 足したか変えたばかりの取得元は、次の取得を待たずに取りに行く
			const fresh = repo
				.listSources()
				.some((s) => s.lastSuccessAt === null && s.lastError === null);
			if (next === null || now() >= next || fresh) void service.run();
		},
		run() {
			if (!running) {
				running = runOnce()
					.catch((e) => console.error("calendar: fetch failed", e))
					.finally(() => {
						running = null;
					});
			}
			return running;
		},
	};
	return service;
}
