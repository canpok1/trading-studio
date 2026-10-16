import type { CalendarStatus, EventSource } from "@trading-studio/backend";
import { useCallback, useState } from "react";
import { Help } from "../../../shared/components/Help";
import { Modal } from "../../../shared/components/Modal";
import { Button, Card } from "../../../shared/components/ui";
import { useApi } from "../../../shared/lib/api";
import { formatDateTime } from "../../../shared/lib/format";
import {
	errorMessage,
	readJson,
	useAsync,
	useInterval,
	usePageVisible,
} from "../../../shared/lib/useAsync";

/** まだ取得していない取得元があるあいだ、取得の結果を問い合わせる間隔 */
const POLL_MS = 5_000;

type Loaded = { sources: EventSource[]; status: CalendarStatus };

/** 予定の取得元（iCal）と取得の状態 */
export function EventCalendarSetting() {
	const api = useApi();
	const load = useCallback(async (): Promise<Loaded> => {
		const [s, st] = await Promise.all([
			api.api.calendar.sources
				.$get()
				.then((r) => readJson<{ sources: EventSource[] }>(r)),
			api.api.calendar.status.$get().then((r) => readJson<CalendarStatus>(r)),
		]);
		return { sources: s.sources, status: st };
	}, [api]);
	const { state, reload } = useAsync(load);
	const visible = usePageVisible();
	const pending =
		state.kind === "ok" &&
		state.data.sources.some(
			(s) => s.lastSuccessAt === null && s.lastError === null,
		);
	useInterval(reload, POLL_MS, visible && pending);
	const [editing, setEditing] = useState<EventSource | "new" | null>(null);

	return (
		<Card className="flex flex-col gap-2.5">
			<div className="flex items-center gap-1.5">
				<h2 className="text-[15px] font-bold">予定の取得元</h2>
				<Help label="予定の取得元">
					<p>
						買いの条件「予定の前後でない」に使う暦。アプリが 2022〜2026
						年の主な予定を持ち、ここに足した取得元（iCal）から 6
						時間ごとに取得した分で延びる。
					</p>
					<p>
						取得した予定は1件ずつ AI
						が「予定の評価基準」で重要度（高・中・低）を判断する。判断はニュースの採点と間隔を空けて順に進める。
					</p>
					<p>
						取得した予定は消さず、バックテストでも使う。暦がそろっていない期間や重要度が未判断の予定（暦切れ）の扱いは条件ごとに選ぶ。
					</p>
				</Help>
			</div>
			{state.kind === "error" ? (
				<p role="alert" className="text-xs font-semibold text-loss">
					読み込めなかった: {state.message}
				</p>
			) : state.kind === "loading" ? null : (
				<>
					<Coverage status={state.data.status} />
					<SourceList
						sources={state.data.sources}
						onEdit={setEditing}
						onChanged={reload}
					/>
					<div className="flex justify-end">
						<Button size="sm" onClick={() => setEditing("new")}>
							取得元を追加
						</Button>
					</div>
				</>
			)}
			{editing && (
				<Modal
					title={editing === "new" ? "取得元を追加" : "取得元を変更"}
					onClose={() => setEditing(null)}
				>
					<SourceForm
						source={editing === "new" ? null : editing}
						onDone={() => {
							setEditing(null);
							reload();
						}}
						onCancel={() => setEditing(null)}
					/>
				</Modal>
			)}
		</Card>
	);
}

function Coverage({ status }: { status: CalendarStatus }) {
	return (
		<div className="flex flex-col gap-0.5 text-xs">
			<span
				data-testid="calendar-coverage"
				className={`num ${status.coveredUntil === null ? "font-semibold text-loss" : "text-text-2"}`}
			>
				{status.coveredUntil === null
					? "暦切れ"
					: `暦は ${formatDateTime(status.coveredUntil)} まで`}
			</span>
			<span data-testid="calendar-unjudged" className="num text-text-2">
				{status.unjudged === 0
					? "すべての予定の重要度を判断済み"
					: `重要度を未判断の予定 ${status.unjudged} 件（順に判断中）`}
			</span>
			{status.failed > 0 && (
				<span
					data-testid="calendar-failed"
					className="num font-semibold text-loss"
				>
					重要度の判断に失敗した予定 {status.failed}{" "}
					件。その前後は暦切れになる（1 時間ごとに判断し直す）
				</span>
			)}
		</div>
	);
}

function SourceList({
	sources,
	onEdit,
	onChanged,
}: {
	sources: EventSource[];
	onEdit: (s: EventSource) => void;
	onChanged: () => void;
}) {
	const api = useApi();
	const [removing, setRemoving] = useState<EventSource | null>(null);
	const [error, setError] = useState<string | null>(null);
	const remove = async (s: EventSource) => {
		setError(null);
		try {
			await api.api.calendar.sources[":id"]
				.$delete({ param: { id: String(s.id) } })
				.then((r) => readJson(r));
			onChanged();
		} catch (e) {
			setError(errorMessage(e));
		}
	};
	return (
		<>
			{sources.length === 0 ? (
				<p className="text-xs text-text-2">
					取得元が無い。アプリが持つ暦だけを使う
				</p>
			) : (
				<div className="overflow-hidden rounded-xl border border-line bg-surface">
					{sources.map((s) => (
						<div
							key={s.id}
							data-testid="event-source"
							className="flex items-center gap-3 border-b border-line px-3.5 py-3 last:border-b-0"
						>
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="text-sm font-semibold">{s.name}</span>
								<span className="truncate text-xs text-text-2">{s.url}</span>
								<span className="num text-xs text-text-2">
									{s.lastSuccessAt === null
										? "まだ取得していない"
										: `最後に取得: ${formatDateTime(s.lastSuccessAt)}`}
								</span>
								{s.lastError && (
									<span className="text-xs font-semibold text-loss">
										{s.lastError}
									</span>
								)}
							</div>
							<Button
								size="sm"
								onClick={() => onEdit(s)}
								aria-label={`${s.name} を変更`}
							>
								変更
							</Button>
							<Button
								size="sm"
								onClick={() => setRemoving(s)}
								aria-label={`${s.name} を削除`}
							>
								削除
							</Button>
						</div>
					))}
				</div>
			)}
			{error && (
				<p role="alert" className="text-xs font-semibold text-loss">
					削除できなかった: {error}
				</p>
			)}
			{removing && (
				<Modal title="取得元を削除する" onClose={() => setRemoving(null)}>
					<p className="text-sm">
						「{removing.name}
						」と、そこから取得した予定を削除する。バックテストでもその予定を使わなくなる。
					</p>
					<div className="grid grid-cols-2 gap-3">
						<Button onClick={() => setRemoving(null)}>やめる</Button>
						<Button
							variant="danger"
							onClick={() => {
								const s = removing;
								setRemoving(null);
								remove(s);
							}}
						>
							削除する
						</Button>
					</div>
				</Modal>
			)}
		</>
	);
}

const inputClass =
	"h-11 w-full rounded-lg border border-line bg-surface px-3 text-[15px] aria-invalid:border-2 aria-invalid:border-loss";

function SourceForm({
	source,
	onDone,
	onCancel,
}: {
	source: EventSource | null;
	onDone: () => void;
	onCancel: () => void;
}) {
	const api = useApi();
	const [name, setName] = useState(source?.name ?? "");
	const [url, setUrl] = useState(source?.url ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<{
		field?: string;
		message: string;
	} | null>(null);
	const changesData = source !== null && url.trim() !== source.url;

	const save = async () => {
		setBusy(true);
		setError(null);
		try {
			const json = { name, url };
			const res =
				source === null
					? await api.api.calendar.sources.$post({ json })
					: await api.api.calendar.sources[":id"].$put({
							param: { id: String(source.id) },
							json,
						});
			if (!res.ok) {
				setError((await res.json()) as { message: string; field?: string });
				return;
			}
			onDone();
		} catch (e) {
			setError({ message: errorMessage(e) });
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex flex-col gap-2.5">
			<div className="flex flex-col gap-1.5">
				<label
					htmlFor="event-source-name"
					className="text-[13px] font-semibold"
				>
					名前
				</label>
				<input
					id="event-source-name"
					value={name}
					maxLength={40}
					onChange={(e) => setName(e.target.value)}
					aria-invalid={error?.field === "name" || undefined}
					className={inputClass}
				/>
			</div>
			<div className="flex flex-col gap-1.5">
				<label htmlFor="event-source-url" className="text-[13px] font-semibold">
					iCal の URL
				</label>
				<input
					id="event-source-url"
					type="url"
					inputMode="url"
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					placeholder="https://"
					aria-invalid={error?.field === "url" || undefined}
					className={inputClass}
				/>
			</div>
			{changesData && (
				<p className="text-xs text-text-2">
					URL を変えると、この取得元から取得した予定を消して取り直す
				</p>
			)}
			{error && (
				<p role="alert" className="text-xs font-semibold text-loss">
					保存できなかった: {error.message}
				</p>
			)}
			<div className="grid grid-cols-2 gap-3">
				<Button onClick={onCancel}>やめる</Button>
				<Button
					variant="primary"
					disabled={busy || !name.trim() || !url.trim()}
					onClick={save}
				>
					保存する
				</Button>
			</div>
		</div>
	);
}
