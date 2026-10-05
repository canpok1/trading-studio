import type {
	CriteriaVersion,
	NewsItem,
	ScoringModelOption,
	TrialItem,
	TrialResult,
} from "@trading-studio/backend";
import type { AggregationRule, Scores } from "@trading-studio/core";
import { JUDGES } from "@trading-studio/core";
import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../api";
import { formatDateTime } from "../../format";
import { lineDiff } from "../../lib/line-diff";
import { errorMessage, readJson, useAsync } from "../../lib/useAsync";
import { Help } from "../Help";
import { ScoreChip } from "../judgment/JudgmentBadge";
import { Modal } from "../Modal";
import { ErrorState, LoadingCard, Skeleton } from "../States";
import { Button, Card } from "../ui";

/** 一度に試せる記事の数。サーバーの上限と合わせる */
const TRIAL_MAX = 5;
/** 選ぶ候補の記事の数。ニュース画面と同じ */
const PICK_LIMIT = 100;

type Criteria = {
	versions: CriteriaVersion[];
	activeVersion: number | null;
	template: string;
};

export function PromptTab({
	rule,
	onChanged,
	initialTrialIds = [],
}: {
	rule: AggregationRule;
	onChanged: () => void;
	/** 試す記事の初期値（ニュース画面の当たり具合から渡す記事の ID） */
	initialTrialIds?: readonly number[];
}) {
	const api = useApi();
	const load = useCallback(
		() => api.api.scoring.criteria.$get().then((r) => readJson<Criteria>(r)),
		[api],
	);
	const { state, reload } = useAsync(load);
	// モデルとプロンプトは近くに置く（設定の「バックテスト」区分と同じ並び）
	return (
		<>
			<ModelSetting />
			{state.kind === "loading" ? (
				<LoadingCard lines={6} />
			) : state.kind === "error" ? (
				<ErrorState
					what="プロンプトを読み込めなかった"
					next={state.message}
					action={<Button onClick={reload}>もう一度読み込む</Button>}
				/>
			) : (
				<PromptBody
					criteria={state.data}
					rule={rule}
					initialTrialIds={initialTrialIds}
					onChanged={() => {
						reload();
						onChanged();
					}}
				/>
			)}
		</>
	);
}

function ModelSetting() {
	const api = useApi();
	const load = useCallback(
		() =>
			api.api.scoring.model
				.$get()
				.then((r) =>
					readJson<{ models: ScoringModelOption[]; current: string }>(r),
				),
		[api],
	);
	const { state, reload } = useAsync(load);
	const [value, setValue] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
		null,
	);
	const current = state.kind === "ok" ? state.data.current : null;
	useEffect(() => {
		if (current !== null) setValue(current);
	}, [current]);

	const save = async () => {
		if (value === null) return;
		setBusy(true);
		setMessage(null);
		try {
			await api.api.scoring.model
				.$put({ json: { model: value } })
				.then((r) => readJson(r));
			setMessage({
				ok: true,
				text: "モデルを保存した。次に採点するニュースから反映する",
			});
			reload();
		} catch (e) {
			setMessage({ ok: false, text: errorMessage(e) });
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card className="flex flex-col gap-2.5">
			<div className="flex items-center gap-1.5">
				<h2 className="text-[15px] font-bold">
					<label htmlFor="scoring-model">採点に使うモデル</label>
				</h2>
				<Help label="採点に使うモデル">
					<p>モデルを変えても採点済みのニュースは採点し直さない。</p>
				</Help>
			</div>
			{state.kind === "error" ? (
				<p role="alert" className="text-xs font-semibold text-loss">
					読み込めなかった: {state.message}
				</p>
			) : (
				<div className="flex items-center gap-2">
					<select
						id="scoring-model"
						value={value ?? ""}
						disabled={state.kind !== "ok"}
						onChange={(e) => {
							setValue(e.target.value);
							setMessage(null);
						}}
						className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-[15px]"
					>
						{state.kind === "ok" &&
							state.data.models.map((m) => (
								<option key={m.id} value={m.id}>
									{m.label}
								</option>
							))}
					</select>
					<Button
						size="sm"
						disabled={busy || value === null || value === current}
						onClick={save}
					>
						保存
					</Button>
				</div>
			)}
			{message && (
				<p
					role={message.ok ? "status" : "alert"}
					className={`text-xs font-semibold ${message.ok ? "" : "text-loss"}`}
				>
					{message.text}
				</p>
			)}
		</Card>
	);
}

function Template({ template }: { template: string }) {
	// 差し込む場所を目立たせる。ひな形は {news} → {criteria} の順に1回ずつ含む
	const [head = "", rest = ""] = template.split("{news}");
	const [middle = "", tail = ""] = rest.split("{criteria}");
	const slot = (label: string) => (
		<mark className="rounded bg-accent px-1 font-bold text-accent-ink">
			{label}
		</mark>
	);
	return (
		<div className="flex flex-col gap-1.5 rounded-[10px] bg-surface-2 px-3 py-2.5">
			<span className="inline-flex items-center gap-1 text-[11px] font-bold text-text-2">
				<svg
					width="12"
					height="12"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.2"
					aria-hidden="true"
				>
					<rect x="5" y="11" width="14" height="10" rx="2" />
					<path d="M8 11V7a4 4 0 0 1 8 0v4" />
				</svg>
				固定のひな形（編集不可）· 点数の範囲と出力形式は集計の前提
			</span>
			<pre className="num m-0 text-xs leading-relaxed whitespace-pre-wrap text-text-2">
				{head}
				{slot("{ニュースの見出し・概要}")}
				{middle}
				{slot("{採点の基準}")}
				{tail}
			</pre>
		</div>
	);
}

function PromptBody({
	criteria,
	rule,
	onChanged,
	initialTrialIds,
}: {
	criteria: Criteria;
	rule: AggregationRule;
	onChanged: () => void;
	initialTrialIds: readonly number[];
}) {
	const api = useApi();
	const { versions, activeVersion, template } = criteria;
	const active = versions.find((v) => v.version === activeVersion) ?? null;
	const maxVersion = Math.max(0, ...versions.map((v) => v.version));
	const [draft, setDraft] = useState(active?.text ?? "");
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
		null,
	);
	const [trial, setTrial] = useState<
		{ kind: "running" } | { kind: "done"; result: TrialResult } | null
	>(null);
	// 空なら最新の1件で試す
	const [picked, setPicked] = useState<readonly number[]>(() =>
		initialTrialIds.slice(0, TRIAL_MAX),
	);
	const [picking, setPicking] = useState(false);
	// 差分は「選んだ版 → 使用中の版」。未選択なら使用中の1つ前の版と比べる
	const [diffFrom, setDiffFrom] = useState<number | null>(null);
	// 保存済みのどの版とも違うときだけ保存できる。同じ内容の版を増やさないため
	const dirty = !versions.some((v) => v.text === draft.trim());

	const run = async (fn: () => Promise<string>) => {
		setBusy(true);
		setMessage(null);
		try {
			setMessage({ ok: true, text: await fn() });
			onChanged();
		} catch (e) {
			setMessage({ ok: false, text: errorMessage(e) });
		} finally {
			setBusy(false);
		}
	};

	const save = () =>
		run(async () => {
			const r = await api.api.scoring.criteria
				.$post({ json: { text: draft, note } })
				.then((res) => readJson<{ version: CriteriaVersion }>(res));
			setNote("");
			return `v${r.version.version} を保存した（使用中は v${activeVersion} のまま）`;
		});

	const use = (version: number) =>
		run(async () => {
			await api.api.scoring.criteria.active
				.$put({ json: { version } })
				.then((res) => readJson(res));
			const v = versions.find((x) => x.version === version);
			if (v) setDraft(v.text);
			setDiffFrom(null);
			return `v${version} を使用中にした。次に採点するニュースから反映する`;
		});

	const tryIt = async () => {
		setTrial({ kind: "running" });
		try {
			const res = await api.api.scoring.trial.$post({
				json: {
					criteria: draft,
					newsIds: picked.length > 0 ? [...picked] : undefined,
				},
			});
			const body = (await res.json()) as TrialResult | { message: string };
			setTrial({
				kind: "done",
				result:
					"ok" in body
						? body
						: { ok: false, message: (body as { message: string }).message },
			});
		} catch (e) {
			setTrial({
				kind: "done",
				result: { ok: false, message: errorMessage(e) },
			});
		}
	};

	const older = versions.filter((v) => v.version !== activeVersion);
	const fromVersion =
		diffFrom ??
		[...older].reverse().find((v) => v.version < (activeVersion ?? 0))
			?.version ??
		null;
	const from = versions.find((v) => v.version === fromVersion) ?? null;
	const diff = from && active ? lineDiff(from.text, active.text) : [];

	return (
		<>
			<Template template={template} />
			<div className="flex items-center justify-between gap-2 text-xs">
				<span className="flex items-center gap-1.5">
					<label htmlFor="criteria-text" className="font-semibold">
						採点の基準 · v{activeVersion} を元に編集中
					</label>
					<Help label="採点の基準">
						<p>
							ニュース1件を採点するプロンプト。編集できるのは「採点の基準」だけ。版を変えても採点済みのニュースはそのままで、次に採点するニュースから新しい版で採点する。
						</p>
						<p>
							AI
							の応答がこの形式に合わない（範囲外の点数など）ときは採点に失敗として扱い、集計に入れない。
						</p>
						<p>
							保存しても使用中の版は変わらない。版の一覧で「使用する」を押して切り替える。
						</p>
					</Help>
				</span>
				<span className="text-text-2">
					{dirty ? "未保存の変更あり" : "変更なし"}
				</span>
			</div>
			<textarea
				id="criteria-text"
				rows={6}
				value={draft}
				onChange={(e) => {
					setDraft(e.target.value);
					setMessage(null);
				}}
				className="num w-full rounded-lg border-[1.5px] border-accent bg-surface p-3 text-[13px] leading-relaxed"
			/>
			<div className="flex flex-col gap-1.5">
				<label htmlFor="criteria-note" className="text-xs font-semibold">
					版の説明（任意）
				</label>
				<input
					id="criteria-note"
					value={note}
					maxLength={100}
					onChange={(e) => setNote(e.target.value)}
					placeholder="画面から編集"
					className="h-11 w-full rounded-lg border border-line bg-surface px-3 text-[15px]"
				/>
			</div>
			<div className="flex items-center justify-between gap-2 text-xs">
				<span data-testid="trial-targets" className="text-text-2">
					試す記事:{" "}
					{picked.length === 0 ? "最新の1件" : `選んだ ${picked.length} 件`}
				</span>
				<Button size="sm" onClick={() => setPicking(true)}>
					試す記事を選ぶ
				</Button>
			</div>
			<div className="grid grid-cols-2 gap-3">
				<Button
					onClick={tryIt}
					disabled={trial?.kind === "running" || !draft.trim()}
				>
					{picked.length === 0 ? "最新のニュースで試す" : "選んだ記事で試す"}
				</Button>
				<Button
					variant="primary"
					onClick={save}
					disabled={!dirty || busy || !draft.trim()}
				>
					v{maxVersion + 1} として保存
				</Button>
			</div>
			{message && (
				<p
					role={message.ok ? "status" : "alert"}
					className={`text-xs font-semibold ${message.ok ? "" : "text-loss"}`}
				>
					{message.text}
				</p>
			)}
			{trial && <TrialCard trial={trial} rule={rule} />}
			{picking && (
				<PickNewsModal
					initial={picked}
					onDone={(ids) => {
						setPicked(ids);
						setPicking(false);
					}}
					onClose={() => setPicking(false)}
				/>
			)}
			<h2 className="text-[15px] font-bold">版の履歴</h2>
			<div className="overflow-hidden rounded-xl border border-line bg-surface">
				{[...versions].reverse().map((v) => (
					<div
						key={v.version}
						data-testid={`criteria-v${v.version}`}
						className={`flex items-center gap-2.5 border-b border-line px-3.5 py-3 last:border-b-0 ${v.version === fromVersion ? "bg-surface-2" : ""}`}
					>
						<span className="num w-[30px] font-bold">v{v.version}</span>
						<span className="flex flex-1 flex-col gap-0.5">
							<span className="text-[13px]">{v.note}</span>
							<span className="num text-xs text-text-2">
								{formatDateTime(v.createdAt)}
							</span>
						</span>
						{v.version === activeVersion ? (
							<span className="rounded bg-text px-1.5 py-0.5 text-[11px] font-bold text-bg">
								使用中
							</span>
						) : (
							<>
								<Button size="sm" onClick={() => setDiffFrom(v.version)}>
									差分
								</Button>
								<Button
									size="sm"
									disabled={busy}
									onClick={() => use(v.version)}
								>
									使用する
								</Button>
							</>
						)}
					</div>
				))}
			</div>
			{from && active && (
				<>
					<div className="flex items-center justify-between">
						<h2 className="text-[15px] font-bold">
							差分{" "}
							<span className="num">
								v{from.version} → v{active.version}
							</span>
						</h2>
						<span className="num text-xs text-text-2">
							+{diff.filter((d) => d.kind === "add").length} −
							{diff.filter((d) => d.kind === "del").length} 行
						</span>
					</div>
					<div className="num overflow-x-auto rounded-xl border border-line bg-surface text-xs leading-relaxed">
						{diff.map((d, i) => (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: 差分の行は並びで識別する
								key={i}
								className={`grid grid-cols-[22px_minmax(0,1fr)] px-2.5 py-px whitespace-pre-wrap ${d.kind === "add" ? "bg-up-bg" : d.kind === "del" ? "bg-down-bg" : "text-text-2"}`}
							>
								<span
									className={`font-bold ${d.kind === "add" ? "text-profit" : d.kind === "del" ? "text-loss" : ""}`}
								>
									{d.kind === "add" ? "＋" : d.kind === "del" ? "−" : ""}
								</span>
								<span>{d.text || " "}</span>
							</div>
						))}
					</div>
				</>
			)}
		</>
	);
}

function ScoreChips({
	scores,
	rule,
}: {
	scores: Scores;
	rule: AggregationRule;
}) {
	return (
		<div className="flex flex-wrap gap-1.5">
			{JUDGES.map((j) => (
				<ScoreChip key={j} judge={j} score={scores[j]} rule={rule} />
			))}
		</div>
	);
}

function TrialRow({ item, rule }: { item: TrialItem; rule: AggregationRule }) {
	const { news, result } = item;
	return (
		<div
			data-testid="trial-result"
			className="flex flex-col gap-2 border-b border-line pb-3 last:border-b-0 last:pb-0"
		>
			<strong className="text-sm">{news.title}</strong>
			<span className="num text-xs text-text-2">
				{news.sourceName} · {formatDateTime(news.publishedAt)}
			</span>
			<span className="text-xs font-semibold">試した採点</span>
			{result.ok ? (
				<>
					<ScoreChips scores={result.scores} rule={rule} />
					<p className="text-xs leading-relaxed">{result.comment}</p>
				</>
			) : (
				<p role="alert" className="text-xs font-semibold text-loss">
					試せなかった: {result.message}
				</p>
			)}
			<span className="text-xs font-semibold text-text-2">
				保存済みの採点
				{news.stored?.criteriaVersion != null &&
					`（v${news.stored.criteriaVersion}）`}
			</span>
			{news.stored ? (
				<>
					<ScoreChips scores={news.stored.scores} rule={rule} />
					{news.stored.comment && (
						<p className="text-xs leading-relaxed text-text-2">
							{news.stored.comment}
						</p>
					)}
				</>
			) : (
				<p className="text-xs text-text-2">採点済みでない</p>
			)}
		</div>
	);
}

function TrialCard({
	trial,
	rule,
}: {
	rule: AggregationRule;
	trial: { kind: "running" } | { kind: "done"; result: TrialResult };
}) {
	return (
		<Card className="flex flex-col gap-3">
			<span className="text-xs text-text-2">
				試し採点（保存・反映はしない）
			</span>
			{trial.kind === "running" ? (
				<>
					<Skeleton className="h-6 w-2/3" />
					<Skeleton className="h-10 w-full" />
				</>
			) : trial.result.ok ? (
				trial.result.items.map((item) => (
					<TrialRow key={item.news.id} item={item} rule={rule} />
				))
			) : (
				<p role="alert" className="text-xs font-semibold text-loss">
					試せなかった: {trial.result.message}
				</p>
			)}
		</Card>
	);
}

function PickNewsModal({
	initial,
	onDone,
	onClose,
}: {
	initial: readonly number[];
	onDone: (ids: readonly number[]) => void;
	onClose: () => void;
}) {
	const api = useApi();
	const load = useCallback(
		() =>
			api.api.news
				.$get({ query: { limit: String(PICK_LIMIT) } })
				.then((r) => readJson<{ news: NewsItem[] }>(r)),
		[api],
	);
	const { state, reload } = useAsync(load);
	const [selected, setSelected] = useState<readonly number[]>(initial);
	const has = (id: number) => selected.includes(id);
	const toggle = (n: NewsItem) =>
		setSelected((s) =>
			s.includes(n.id) ? s.filter((x) => x !== n.id) : [...s, n.id],
		);
	return (
		<Modal title="試す記事を選ぶ" onClose={onClose}>
			<p className="text-xs text-text-2">
				{TRIAL_MAX} 件まで。1件につき数秒かかる。選ばなければ最新の1件で試す。
			</p>
			{state.kind === "loading" ? (
				<Skeleton className="h-40 w-full" />
			) : state.kind === "error" ? (
				<ErrorState
					what="ニュースを読み込めなかった"
					next={state.message}
					action={<Button onClick={reload}>もう一度読み込む</Button>}
				/>
			) : state.data.news.length === 0 ? (
				<p className="text-xs text-text-2">ニュースがまだ無い</p>
			) : (
				<>
					<OutsidePicked
						selected={selected}
						listed={state.data.news}
						onRemove={(ids) =>
							setSelected((s) => s.filter((id) => !ids.includes(id)))
						}
					/>
					<div className="flex flex-col overflow-hidden rounded-xl border border-line">
						{state.data.news.map((n) => {
							const on = has(n.id);
							return (
								<label
									key={n.id}
									className="flex items-start gap-2.5 border-b border-line px-3 py-2.5 last:border-b-0"
								>
									<input
										type="checkbox"
										checked={on}
										disabled={!on && selected.length >= TRIAL_MAX}
										onChange={() => toggle(n)}
										className="mt-1"
									/>
									<span className="flex flex-col gap-0.5">
										<span className="text-[13px]">{n.title}</span>
										<span className="num text-xs text-text-2">
											{n.sourceName} · {formatDateTime(n.publishedAt)}
											{n.score?.status === "done" && n.score.scores
												? ` · 採点済み v${n.score.criteriaVersion ?? "?"}`
												: " · 未採点"}
										</span>
									</span>
								</label>
							);
						})}
					</div>
				</>
			)}
			<div className="grid grid-cols-2 gap-3">
				<Button onClick={() => onDone([])}>最新の1件に戻す</Button>
				<Button
					variant="primary"
					disabled={selected.length === 0}
					onClick={() => onDone(selected)}
				>
					{selected.length} 件で決定
				</Button>
			</div>
		</Modal>
	);
}

/** ニュース画面の当たり具合から渡した記事のうち、直近の一覧に無いもの。一覧で外せないので、まとめて外せるようにする */
function OutsidePicked({
	selected,
	listed,
	onRemove,
}: {
	selected: readonly number[];
	listed: readonly NewsItem[];
	onRemove: (ids: readonly number[]) => void;
}) {
	const outside = selected.filter((id) => !listed.some((n) => n.id === id));
	if (outside.length === 0) return null;
	return (
		<div className="flex items-center justify-between gap-2 text-xs">
			<span className="text-text-2">
				一覧に無い記事を {outside.length} 件選んでいる
			</span>
			<Button size="sm" onClick={() => onRemove(outside)}>
				外す
			</Button>
		</div>
	);
}
