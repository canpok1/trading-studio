import type { ImportJob, TimeframeCoverage } from "@trading-studio/backend";
import type { Timeframe } from "@trading-studio/core";
import {
	CSV_EXPECTED_FORMAT,
	TIMEFRAME_LABELS,
	TIMEFRAME_MS,
	TIMEFRAMES,
} from "@trading-studio/core";
import type { DragEvent } from "react";
import { useCallback, useId, useState } from "react";
import { useApi } from "../api";
import { DataIcon, ErrorIcon } from "../components/icons";
import { Page } from "../components/Page";
import { EmptyState, ErrorState, LoadingCard } from "../components/States";
import {
	Button,
	buttonClass,
	Card,
	Note,
	ProgressBar,
	Segmented,
} from "../components/ui";
import {
	formatDate,
	formatDateTime,
	fromDateInputValue,
	toDateInputValue,
} from "../format";
import { formatInt } from "../lib/number";
import { errorMessage, readJson, useAsync, useInterval } from "../lib/useAsync";

const TF_OPTIONS = TIMEFRAMES.map(
	(t) => [t, TIMEFRAME_LABELS[t].replace("足", "")] as const,
);

const PHASE_LABEL: Record<NonNullable<ImportJob["phase"]>, string> = {
	validating: "検証中",
	confirming: "上書きするかの選択待ち",
	saving: "保存中",
	deriving: "粗い粒度の足を作成中",
};

type Data = { coverage: TimeframeCoverage[]; imports: ImportJob[] };

export function DataPage() {
	const api = useApi();
	const [timeframe, setTimeframe] = useState<Timeframe>("1m");
	const [job, setJob] = useState<ImportJob | null>(null);
	const [failure, setFailure] = useState<{
		fileName: string;
		job: ImportJob | null;
		message: string;
	} | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [dragging, setDragging] = useState(false);
	const inputId = useId();

	const load = useCallback(async (): Promise<Data> => {
		const [cov, imp] = await Promise.all([
			api.api.data.coverage
				.$get()
				.then((r) => readJson<{ timeframes: TimeframeCoverage[] }>(r)),
			api.api.data.imports
				.$get()
				.then((r) => readJson<{ imports: ImportJob[] }>(r)),
		]);
		// 画面を離れていた間に進んでいる取り込みがあれば、その進捗を追う
		const running = imp.imports.find((j) => j.status === "running");
		if (running) setJob((cur) => cur ?? running);
		return { coverage: cov.timeframes, imports: imp.imports };
	}, [api]);
	const { state, reload } = useAsync(load);

	const settle = useCallback(
		(j: ImportJob) => {
			setJob(null);
			if (j.status === "done") {
				setNotice(
					`${formatInt(j.insertedRows)} 行を取り込んだ${j.skippedRows ? `（同じ日時の ${formatInt(j.skippedRows)} 行は読み飛ばした）` : ""}`,
				);
			} else if (j.status === "canceled") {
				setNotice("取り込みを中止した。この取り込みで保存した行は消した");
			} else {
				setFailure({
					fileName: j.fileName,
					job: j,
					message: j.message ?? "取り込めなかった",
				});
			}
			reload();
		},
		[reload],
	);

	useInterval(
		async () => {
			if (!job) return;
			try {
				const res = await api.api.data.imports[":id"].$get({
					param: { id: String(job.id) },
				});
				const { job: next } = await readJson<{ job: ImportJob }>(res);
				if (next.status === "running") setJob(next);
				else settle(next);
			} catch {
				// 一時的な失敗は次の問い合わせで取り直す
			}
		},
		500,
		job !== null,
	);

	const upload = async (file: File) => {
		setFailure(null);
		setNotice(null);
		try {
			const res = await api.api.data.imports.$post({
				form: { file, timeframe },
			});
			const body = (await res.json()) as { job?: ImportJob; message?: string };
			if (res.status === 409 && body.job) {
				setJob(body.job);
				setNotice(body.message ?? null);
				return;
			}
			if (!res.ok || !body.job)
				throw new Error(body.message ?? `HTTP ${res.status}`);
			setJob(body.job);
		} catch (e) {
			setFailure({
				fileName: file.name,
				job: null,
				message: `送信できなかった: ${errorMessage(e)}`,
			});
		}
	};

	const cancel = async () => {
		if (!job) return;
		await api.api.data.imports[":id"].cancel.$post({
			param: { id: String(job.id) },
		});
	};

	const resolve = async (overwrite: boolean) => {
		if (!job) return;
		try {
			const res = await api.api.data.imports[":id"].resolve.$post({
				param: { id: String(job.id) },
				json: { overwrite },
			});
			const { job: next } = await readJson<{ job: ImportJob }>(res);
			setJob(next);
		} catch (e) {
			setNotice(`選択を送れなかった: ${errorMessage(e)}`);
		}
	};

	const onDrop = (e: DragEvent) => {
		e.preventDefault();
		setDragging(false);
		const file = e.dataTransfer.files[0];
		if (file && !job) upload(file);
	};

	return (
		<Page
			title="過去データ"
			description="バックテストに使う BTC/JPY の足を CSV で取り込む"
		>
			<section
				aria-label="CSV の取り込み"
				onDragOver={(e) => {
					e.preventDefault();
					setDragging(true);
				}}
				onDragLeave={() => setDragging(false)}
				onDrop={onDrop}
				className={`flex flex-col items-center gap-2.5 rounded-xl border-2 border-dashed bg-surface px-4 py-5 text-center ${dragging ? "border-accent" : "border-line"}`}
			>
				<span className="text-text-2">
					<DataIcon size={32} />
				</span>
				<div className="w-full max-w-md">
					<Segmented
						name="timeframe"
						label="取り込む足の粒度"
						options={TF_OPTIONS}
						value={timeframe}
						onChange={setTimeframe}
						disabled={job !== null}
						size="sm"
					/>
				</div>
				<label
					htmlFor={inputId}
					aria-disabled={job !== null}
					className={`${buttonClass("primary")} cursor-pointer aria-disabled:pointer-events-none aria-disabled:opacity-45`}
				>
					{TIMEFRAME_LABELS[timeframe]}の CSV ファイルを選ぶ
				</label>
				<input
					id={inputId}
					type="file"
					accept=".csv,text/csv"
					className="sr-only"
					disabled={job !== null}
					onChange={(e) => {
						const file = e.target.files?.[0];
						if (file) upload(file);
						e.target.value = "";
					}}
				/>
				<p className="text-xs leading-relaxed text-text-2">
					列: {CSV_EXPECTED_FORMAT}。
					<span className="hidden lg:inline">
						ここへドラッグ＆ドロップもできる。
					</span>
				</p>
			</section>

			{job?.phase === "confirming" ? (
				<ConfirmCard job={job} onResolve={resolve} onCancel={cancel} />
			) : (
				job && <JobCard job={job} onCancel={cancel} />
			)}
			{notice && (
				<div
					role="status"
					className="rounded-[10px] bg-surface-2 px-3.5 py-3 text-[13px]"
				>
					{notice}
				</div>
			)}
			{failure && (
				<FailureCard
					failure={failure}
					inputId={inputId}
					onClose={() => setFailure(null)}
				/>
			)}

			<h2 className="text-[15px] font-bold">取り込み済み</h2>
			{state.kind === "loading" && <LoadingCard lines={2} />}
			{state.kind === "error" && (
				<Card>
					<ErrorState
						what="取り込み済みのデータを読み込めなかった"
						next="サーバーが動いているか確かめてから、もう一度読み込む"
						action={
							<Button size="sm" onClick={reload}>
								再読み込み
							</Button>
						}
					/>
				</Card>
			)}
			{state.kind === "ok" && <Coverage data={state.data} runningJob={job} />}
			<p className="text-xs leading-relaxed text-text-2">
				取り込んだ足より粗い粒度（5分・15分・1時間・4時間・日足）は自動で作る。取り込んだ・収集した足と同じ粒度・同じ日時の行があれば、上書きするかを選ぶ。
			</p>

			{state.kind === "ok" && state.data.coverage.some((c) => c.count > 0) && (
				<>
					<h2 className="text-[15px] font-bold">エクスポート</h2>
					<ExportCard coverage={state.data.coverage} />
				</>
			)}
		</Page>
	);
}

function JobCard({ job, onCancel }: { job: ImportJob; onCancel: () => void }) {
	const pct = job.totalRows ? (job.processedRows / job.totalRows) * 100 : 0;
	return (
		<Card className="flex flex-col gap-2">
			<div className="flex items-center justify-between gap-2">
				<span className="num truncate font-semibold">{job.fileName}</span>
				<span className="num font-semibold">{Math.round(pct)}%</span>
			</div>
			<ProgressBar value={pct} label="取り込みの進捗" />
			<div className="flex items-center justify-between gap-2">
				<span className="num text-xs text-text-2">
					{job.phase ? PHASE_LABEL[job.phase] : ""} ·{" "}
					{formatInt(job.processedRows)} / {formatInt(job.totalRows)} 行 · 重複{" "}
					{formatInt(job.skippedRows)}
				</span>
				<Button
					variant="link"
					className="text-text-2"
					onClick={onCancel}
					disabled={
						job.phase === "deriving" ||
						(job.phase === "saving" && job.overwrite === true)
					}
				>
					中止
				</Button>
			</div>
		</Card>
	);
}

/** 既存の足と重なったときに、上書きするかを選ぶ */
function ConfirmCard({
	job,
	onResolve,
	onCancel,
}: {
	job: ImportJob;
	onResolve: (overwrite: boolean) => void;
	onCancel: () => void;
}) {
	const o = job.overlap;
	return (
		<section
			aria-label="既存の足との重なり"
			className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface px-4 py-3.5"
		>
			<strong className="num truncate">{job.fileName}</strong>
			<Note>
				取り込む足のうち {formatInt(o?.count ?? 0)}{" "}
				本が、取り込み済み・収集済みの足と同じ日時にある
				{o && (
					<span className="num block">
						{formatDateTime(o.from)} 〜 {formatDateTime(o.to)}
					</span>
				)}
			</Note>
			<div className="flex flex-col gap-2 sm:flex-row">
				<Button variant="primary" size="sm" onClick={() => onResolve(true)}>
					上書きする
				</Button>
				<Button size="sm" onClick={() => onResolve(false)}>
					上書きしない（重なる足だけ読み飛ばす）
				</Button>
				<Button variant="link" className="text-text-2" onClick={onCancel}>
					中止
				</Button>
			</div>
			<p className="text-xs text-text-2">
				上書きすると、重なる足と、そこから作った粗い足を置き換える。上書きの保存を始めた後は中止できない
			</p>
		</section>
	);
}

function FailureCard({
	failure,
	inputId,
	onClose,
}: {
	failure: { fileName: string; job: ImportJob | null; message: string };
	inputId: string;
	onClose: () => void;
}) {
	const errors = failure.job?.errors ?? [];
	const more = (failure.job?.errorCount ?? 0) - errors.length;
	return (
		<section
			role="alert"
			className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface px-4 py-3.5"
		>
			<div className="flex items-center gap-2">
				<span className="shrink-0 text-loss">
					<ErrorIcon size={20} />
				</span>
				<strong className="num truncate">{failure.fileName}</strong>
			</div>
			<p className="text-[13px] leading-relaxed">{failure.message}</p>
			{errors.length > 0 && (
				<div className="num overflow-x-auto rounded-lg bg-bg px-3 py-2.5 text-xs leading-7">
					{errors.slice(0, 5).map((e) => (
						<div key={e.line}>
							<span className="font-semibold text-loss">{e.line} 行目</span>:{" "}
							{e.message}
							<div className="whitespace-pre text-text-2">{e.content}</div>
						</div>
					))}
					{errors.length > 5 || more > 0 ? (
						<div className="text-text-2">
							ほか{" "}
							{formatInt(errors.length - Math.min(5, errors.length) + more)} 件
						</div>
					) : null}
					<div className="mt-1 whitespace-normal">
						期待する形式: {CSV_EXPECTED_FORMAT}
					</div>
				</div>
			)}
			<div className="flex gap-2">
				<label
					htmlFor={inputId}
					className={`${buttonClass("primary", "sm")} cursor-pointer`}
				>
					別のファイルを選ぶ
				</label>
				<Button size="sm" onClick={onClose}>
					閉じる
				</Button>
			</div>
		</section>
	);
}

function Coverage({
	data,
	runningJob,
}: {
	data: Data;
	runningJob: ImportJob | null;
}) {
	const withData = data.coverage.filter((c) => c.count > 0);
	if (withData.length === 0) {
		return (
			<Card>
				<EmptyState
					title="取り込んだデータはまだない"
					description="CSV を選ぶと、ここに期間が並ぶ"
				/>
			</Card>
		);
	}
	const firsts = withData.map((c) => c.firstTime as number);
	const lasts = withData.map(
		(c) => (c.lastTime as number) + TIMEFRAME_MS[c.timeframe],
	);
	const min = Math.min(...firsts);
	const max = Math.max(...lasts);
	const span = Math.max(1, max - min);
	const pos = (t: number) => ((t - min) / span) * 100;
	const ticks = [0, 1 / 3, 2 / 3, 1].map((r) => formatDate(min + span * r));
	const gapNotes = withData.filter((c) => c.gapCount > 0);

	return (
		<>
			<Card className="flex flex-col gap-2.5">
				{withData.map((c) => {
					const end = (c.lastTime as number) + TIMEFRAME_MS[c.timeframe];
					return (
						<div key={c.timeframe} className="flex flex-col gap-1">
							<div className="flex justify-between text-xs">
								<span className="font-semibold">
									{TIMEFRAME_LABELS[c.timeframe]}
								</span>
								<span className="num text-text-2">{formatInt(c.count)} 本</span>
							</div>
							<div
								className="relative h-4 overflow-hidden rounded bg-surface-2"
								role="img"
								aria-label={`${TIMEFRAME_LABELS[c.timeframe]}: ${formatDate(c.firstTime as number)}〜${formatDate(end - 1)}${c.gapCount ? `、欠損 ${c.gapCount} か所` : ""}`}
							>
								<div
									className="absolute inset-y-0 bg-accent"
									style={{
										left: `${pos(c.firstTime as number)}%`,
										width: `${Math.max(0.4, pos(end) - pos(c.firstTime as number))}%`,
									}}
								/>
								{c.gaps.map((g) => (
									<div
										key={g.from}
										className="absolute inset-y-0 bg-warn-strong"
										style={{
											left: `${pos(g.from)}%`,
											width: `${Math.max(0.4, pos(g.to) - pos(g.from))}%`,
										}}
									/>
								))}
								{runningJob?.firstTime != null &&
									runningJob.lastTime != null &&
									runningJob.timeframe === c.timeframe && (
										<div
											className="absolute inset-y-0 animate-pulse bg-accent/40"
											style={{
												left: `${pos(runningJob.firstTime)}%`,
												width: `${Math.max(0.4, pos(runningJob.lastTime) - pos(runningJob.firstTime))}%`,
											}}
										/>
									)}
							</div>
						</div>
					);
				})}
				<div className="num flex justify-between text-[11px] text-text-2">
					{ticks.map((t, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: 目盛りは位置で決まる
						<span key={i}>{t}</span>
					))}
				</div>
				<div className="flex flex-wrap gap-x-3 gap-y-1.5 text-[11px] text-text-2">
					<Key className="bg-accent">あり</Key>
					<Key className="bg-warn-strong">欠損</Key>
					<Key className="animate-pulse bg-accent/40">取り込み中</Key>
					<Key className="border border-line bg-surface-2">なし</Key>
				</div>
			</Card>

			{gapNotes.length > 0 && <GapNote coverage={gapNotes} />}

			<ImportHistory imports={data.imports} />
		</>
	);
}

const DAY = 24 * 60 * 60 * 1000;

/** 保存済みの足を CSV で書き出す。書き出した CSV はそのまま取り込み直せる */
function ExportCard({ coverage }: { coverage: TimeframeCoverage[] }) {
	const api = useApi();
	const ids = { from: useId(), to: useId() };
	const withData = coverage.filter((c) => c.count > 0);
	const [timeframe, setTimeframe] = useState<Timeframe>(
		withData.some((c) => c.timeframe === "1m")
			? "1m"
			: (withData[0]?.timeframe ?? "1m"),
	);
	// 未指定なら、選んだ粒度の保存済みの全期間
	const [period, setPeriod] = useState<{ from: string; to: string } | null>(
		null,
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const cov = withData.find((c) => c.timeframe === timeframe);
	const fromDate =
		period?.from ?? toDateInputValue((cov?.firstTime as number) ?? Date.now());
	const toDate =
		period?.to ?? toDateInputValue((cov?.lastTime as number) ?? Date.now());
	const fromMs = fromDateInputValue(fromDate);
	const toMs = fromDateInputValue(toDate);
	const periodError =
		fromMs === null || toMs === null
			? "開始日と終了日を入れる"
			: fromMs > toMs
				? "終了日は開始日より後にする"
				: null;

	const run = async () => {
		if (fromMs === null || toMs === null) return;
		setBusy(true);
		setError(null);
		try {
			const res = await api.api.data.export.$get({
				query: { timeframe, from: String(fromMs), to: String(toMs + DAY) },
			});
			if (!res.ok) await readJson(res);
			const blob = await res.blob();
			const name =
				/filename="([^"]+)"/.exec(
					res.headers.get("content-disposition") ?? "",
				)?.[1] ?? "btcjpy.csv";
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = name;
			a.click();
			// すぐ無効にすると、保存が始まる前に URL が消えるブラウザがある
			setTimeout(() => URL.revokeObjectURL(url), 60_000);
		} catch (e) {
			setError(`書き出せなかった: ${errorMessage(e)}`);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card className="flex flex-col gap-3">
			<Segmented
				name="export-timeframe"
				label="書き出す足の粒度"
				options={TF_OPTIONS.filter(([t]) =>
					withData.some((c) => c.timeframe === t),
				)}
				value={timeframe}
				onChange={(t) => {
					setTimeframe(t);
					setPeriod(null);
				}}
				disabled={busy}
				size="sm"
			/>
			<div className="grid grid-cols-[minmax(0,1fr)_20px_minmax(0,1fr)] items-end gap-1.5">
				<div className="flex flex-col gap-1">
					<label htmlFor={ids.from} className="text-xs text-text-2">
						開始
					</label>
					<input
						id={ids.from}
						type="date"
						value={fromDate}
						onChange={(e) => setPeriod({ from: e.target.value, to: toDate })}
						disabled={busy}
						className="num h-11 min-w-0 rounded-[10px] border border-line bg-surface px-2 text-sm"
					/>
				</div>
				<span className="pb-3 text-center text-text-2">〜</span>
				<div className="flex flex-col gap-1">
					<label htmlFor={ids.to} className="text-xs text-text-2">
						終了
					</label>
					<input
						id={ids.to}
						type="date"
						value={toDate}
						onChange={(e) => setPeriod({ from: fromDate, to: e.target.value })}
						disabled={busy}
						className="num h-11 min-w-0 rounded-[10px] border border-line bg-surface px-2 text-sm"
					/>
				</div>
			</div>
			{periodError && (
				<p role="alert" className="text-xs font-semibold text-loss">
					{periodError}
				</p>
			)}
			{error && (
				<p role="alert" className="text-xs font-semibold text-loss">
					{error}
				</p>
			)}
			<Button
				variant="primary"
				onClick={run}
				disabled={busy || periodError !== null}
			>
				{busy
					? "書き出し中…"
					: `${TIMEFRAME_LABELS[timeframe]}を CSV で書き出す`}
			</Button>
			<p className="text-xs leading-relaxed text-text-2">
				取り込みと同じ列（日時は
				JST）で書き出すので、そのまま取り込み直せる。欠損は埋めない。1分足を残せば、粗い粒度は取り込み直したときに作り直される。
			</p>
		</Card>
	);
}

/** 欠損の注意。区間は最も細かい粒度のものを出す（粗い粒度の欠損はその中に含まれる） */
function GapNote({ coverage }: { coverage: TimeframeCoverage[] }) {
	const finest = coverage[0] as TimeframeCoverage;
	return (
		<Note>
			<strong>
				欠損あり:{" "}
				{coverage
					.map(
						(c) =>
							`${TIMEFRAME_LABELS[c.timeframe]} ${formatInt(c.gapCount)} か所`,
					)
					.join("、")}
			</strong>
			。この期間を含むバックテストは実行前に確認を出す。
			<ul className="num mt-1">
				{finest.gaps.slice(0, 5).map((g) => (
					<li key={g.from}>
						{formatDateTime(g.from)}〜{formatDateTime(g.to)}（
						{TIMEFRAME_LABELS[finest.timeframe]} {formatInt(g.missing)} 本）
					</li>
				))}
				{finest.gapCount > 5 && (
					<li>ほか {formatInt(finest.gapCount - 5)} か所</li>
				)}
			</ul>
		</Note>
	);
}

function Key({ className, children }: { className: string; children: string }) {
	return (
		<span className="inline-flex items-center gap-1">
			<span
				className={`inline-block h-[11px] w-[11px] rounded-sm ${className}`}
			/>
			{children}
		</span>
	);
}

const STATUS_LABEL: Record<ImportJob["status"], string> = {
	running: "取り込み中",
	done: "",
	failed: "失敗",
	canceled: "中止",
};

function ImportHistory({ imports }: { imports: ImportJob[] }) {
	if (imports.length === 0) return null;
	return (
		<section
			aria-label="取り込みの履歴"
			className="overflow-hidden rounded-xl border border-line bg-surface"
		>
			{imports.map((j) => (
				<div
					key={j.id}
					className="flex items-center justify-between gap-2 border-b border-line px-3.5 py-3 last:border-b-0"
				>
					<span className="flex min-w-0 flex-col gap-0.5">
						<span className="num font-semibold">
							{j.firstTime != null && j.lastTime != null
								? `${formatDate(j.firstTime)}〜${formatDate(j.lastTime)}`
								: j.fileName}
						</span>
						<span className="num truncate text-xs text-text-2">
							{TIMEFRAME_LABELS[j.timeframe]} · {formatInt(j.insertedRows)} 行 ·{" "}
							{formatDateTime(j.startedAt)} 取り込み
						</span>
					</span>
					{STATUS_LABEL[j.status] && (
						<span className="shrink-0 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-semibold">
							{STATUS_LABEL[j.status]}
						</span>
					)}
				</div>
			))}
		</section>
	);
}
