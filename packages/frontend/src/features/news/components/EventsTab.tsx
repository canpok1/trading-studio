import type {
	CalendarStatus,
	EventListResult,
	ListedEvent,
} from "@trading-studio/backend";
import type { EventImportance } from "@trading-studio/core";
import { EVENT_IMPORTANCE_LABELS } from "@trading-studio/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Help } from "../../../shared/components/Help";
import {
	EmptyState,
	ErrorState,
	Skeleton,
} from "../../../shared/components/States";
import { Button } from "../../../shared/components/ui";
import { useApi } from "../../../shared/lib/api";
import {
	formatDateTime,
	formatDateWeekday,
	formatDateWeekdayTime,
	formatTime,
} from "../../../shared/lib/format";
import {
	errorMessage,
	readJson,
	useInterval,
} from "../../../shared/lib/useAsync";

/** 予定と判断の状態を問い合わせる間隔 */
const POLL_MS = 5_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** 期間。今からの範囲。これからの予定には、終わったばかりの予定も見えるよう1日前から入れる */
const PERIODS = [
	["next7", "これから7日", -DAY_MS, 7 * DAY_MS],
	["next30", "これから30日", -DAY_MS, 30 * DAY_MS],
	["past30", "過去30日", -30 * DAY_MS, 0],
	["past365", "過去1年", -365 * DAY_MS, 0],
] as const;
type Period = (typeof PERIODS)[number][0];
const MINS = [
	["all", "すべて"],
	["medium", "中以上"],
	["high", "高"],
] as const;
type Min = (typeof MINS)[number][0];

const IMPORTANCE_CLASS: Record<EventImportance, string> = {
	high: "bg-loss text-white",
	medium: "bg-warn-strong text-paper-ink",
	low: "bg-surface-2 text-text-2",
};

const selectClass = "h-9 rounded-lg border border-line bg-surface px-2 text-sm";

/** 予定の一覧と AI の重要度の判断（ニュース画面の「予定」のタブ） */
export function EventsTab({ visible }: { visible: boolean }) {
	const api = useApi();
	const [params, setParams] = useSearchParams();
	// 記事の絞り込み（period など）と URL の名前が重ならないようにする
	const periodParam = params.get("span");
	const period: Period =
		PERIODS.find(([k]) => k === periodParam)?.[0] ?? "next30";
	const minParam = params.get("min");
	const min: Min = MINS.find(([k]) => k === minParam)?.[0] ?? "all";
	const set = (key: string, value: string, fallback: string) => {
		const next = new URLSearchParams(params);
		if (value === fallback) next.delete(key);
		else next.set(key, value);
		setParams(next, { replace: true });
	};

	const [data, setData] = useState<{
		list: EventListResult;
		status: CalendarStatus;
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	// 条件を変えた直後と定期の問い合わせが重なると応答の順が入れ替わりうるので、最後に出したものだけ使う
	const seq = useRef(0);
	const load = useCallback(async () => {
		const id = ++seq.current;
		const [, , before, after] =
			PERIODS.find(([k]) => k === period) ?? PERIODS[1];
		const now = Date.now();
		try {
			const [list, status] = await Promise.all([
				api.api.calendar.events
					.$get({
						query: {
							from: String(now + before),
							to: String(now + after),
							...(min === "all" ? {} : { minImportance: min }),
						},
					})
					.then((r) => readJson<EventListResult>(r)),
				api.api.calendar.status.$get().then((r) => readJson<CalendarStatus>(r)),
			]);
			if (id !== seq.current) return;
			setData({ list, status });
			setError(null);
		} catch (e) {
			if (id === seq.current) setError(errorMessage(e));
		}
	}, [api, period, min]);
	useEffect(() => {
		if (visible) load();
	}, [visible, load]);
	useInterval(load, POLL_MS, visible);

	return (
		<>
			<div className="flex items-center gap-1.5">
				<h2 className="text-[15px] font-bold">予定</h2>
				<Help label="予定">
					<p>
						買いの条件「予定の前後でない」に使う予定。設定の「ニュース」→「予定」の取得元（iCal）から取得した予定と、アプリが持つ
						2022〜2026 年の主な予定を並べる。
					</p>
					<p>
						予定ごとに AI
						が「予定の評価基準」の使用中の版で重要度（高・中・低）を判断する。判断はニュースの採点と間隔を空けて1件ずつ進む。判断していない予定・失敗した予定が条件の範囲にあると暦切れになる。
					</p>
				</Help>
				<Link
					to="/settings?section=news&tab=events"
					className="ml-auto text-xs font-semibold text-accent"
				>
					予定の設定を開く
				</Link>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<select
					aria-label="期間"
					value={period}
					onChange={(e) => set("span", e.target.value, "next30")}
					className={selectClass}
				>
					{PERIODS.map(([k, label]) => (
						<option key={k} value={k}>
							{label}
						</option>
					))}
				</select>
				<select
					aria-label="重要度"
					value={min}
					onChange={(e) => set("min", e.target.value, "all")}
					className={selectClass}
				>
					{MINS.map(([k, label]) => (
						<option key={k} value={k}>
							重要度 {label}
						</option>
					))}
				</select>
			</div>
			{!data ? (
				error ? (
					<ErrorState
						what="予定を読み込めなかった"
						next={error}
						action={<Button onClick={load}>もう一度読み込む</Button>}
					/>
				) : (
					<Skeleton className="h-[240px] w-full" />
				)
			) : (
				<>
					<p data-testid="events-summary" className="num text-xs text-text-2">
						{[
							`v${data.list.version} で判断`,
							data.status.coveredUntil === null
								? "暦切れ"
								: `暦は ${formatDateTime(data.status.coveredUntil)} まで`,
							...(data.status.unjudged > 0
								? [`未判断 ${data.status.unjudged} 件`]
								: []),
							...(data.status.failed > 0
								? [`失敗 ${data.status.failed} 件`]
								: []),
							`${data.list.total} 件`,
						].join(" · ")}
					</p>
					{error && (
						<p role="alert" className="text-xs font-semibold text-loss">
							最新の状態を読み込めなかった（{error}）。5秒ごとに読み直している
						</p>
					)}
					{data.list.events.length === 0 ? (
						<EmptyState
							title="この期間に予定は無い"
							description="取得元は設定の「ニュース」→「予定」で足す。"
						/>
					) : (
						<div className="overflow-hidden rounded-xl border border-line bg-surface">
							{data.list.events.map((e) => (
								<EventRow
									key={e.id}
									event={e}
									version={data.list.version}
									onChanged={load}
								/>
							))}
						</div>
					)}
					{data.list.events.length < data.list.total && (
						<p className="text-center text-xs text-text-2">
							{data.list.events.length}{" "}
							件まで出す。続きは期間や重要度で絞って見る
						</p>
					)}
				</>
			)}
		</>
	);
}

function when(e: ListedEvent) {
	return e.allDay
		? `${formatDateWeekday(e.start)}（終日）`
		: formatDateWeekdayTime(e.start);
}

function JudgmentText({ event }: { event: ListedEvent }) {
	const j = event.judgment;
	if (j === null) return <span className="text-text-2">判断待ち</span>;
	switch (j.status) {
		case "done":
			return null;
		case "pending":
			return <span className="text-text-2">判断待ち</span>;
		case "retry":
			return (
				<span className="text-text-2">
					再試行待ち
					{j.nextAttemptAt !== null && `（${formatTime(j.nextAttemptAt)}）`}
				</span>
			);
		case "failed":
			return (
				<span className="font-semibold text-loss">
					判断に失敗（{j.error}）。前後は暦切れ
				</span>
			);
	}
}

function EventRow({
	event: e,
	version,
	onChanged,
}: {
	event: ListedEvent;
	version: number;
	onChanged: () => void;
}) {
	const api = useApi();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const j = e.judgment;
	const rejudge = async () => {
		setBusy(true);
		setError(null);
		try {
			await api.api.calendar.events[":id"].judge
				.$post({ param: { id: String(e.id) }, json: { version } })
				.then((r) => readJson(r));
			onChanged();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div
			data-testid="event"
			className="flex flex-col gap-1 border-b border-line px-3.5 py-3 last:border-b-0"
		>
			<div className="flex items-start gap-2">
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="num text-xs text-text-2">{when(e)}</span>
					<span className="text-sm font-semibold">{e.title}</span>
				</span>
				{j?.status === "done" && (
					<span
						className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-bold ${IMPORTANCE_CLASS[j.importance]}`}
					>
						重要度 {EVENT_IMPORTANCE_LABELS[j.importance]}
					</span>
				)}
			</div>
			<span className="text-xs">
				<JudgmentText event={e} />
			</span>
			{j?.status === "done" && (
				<p className="text-xs text-text-2">{j.reason}</p>
			)}
			<details className="text-xs">
				<summary className="cursor-pointer text-text-2">詳しく</summary>
				<div className="mt-1.5 flex flex-col gap-1.5">
					<span className="text-text-2">
						取得元: {e.sourceName ?? "アプリが持つ過去の予定"}
					</span>
					{e.description && (
						<p className="whitespace-pre-wrap text-text-2">{e.description}</p>
					)}
					{j?.status === "done" && (
						<span className="num text-text-2">
							{formatDateTime(j.judgedAt)} · {j.model}
						</span>
					)}
					<Button
						size="sm"
						className="self-start"
						disabled={busy || j?.status === "pending"}
						onClick={rejudge}
					>
						v{version} で判断し直す
					</Button>
					{error && (
						<span role="alert" className="font-semibold text-loss">
							頼めなかった: {error}
						</span>
					)}
				</div>
			</details>
		</div>
	);
}
