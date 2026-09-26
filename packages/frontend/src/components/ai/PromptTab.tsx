import type { CriteriaVersion, TrialResult } from "@trading-studio/backend";
import type { AggregationRule } from "@trading-studio/core";
import { JUDGES } from "@trading-studio/core";
import { useCallback, useState } from "react";
import { useApi } from "../../api";
import { formatDateTime } from "../../format";
import { lineDiff } from "../../lib/line-diff";
import { errorMessage, readJson, useAsync } from "../../lib/useAsync";
import { ScoreChip } from "../judgment/JudgmentBadge";
import { ErrorState, LoadingCard, Skeleton } from "../States";
import { Button, Card } from "../ui";

type Criteria = {
	versions: CriteriaVersion[];
	activeVersion: number | null;
	template: string;
};

export function PromptTab({
	rule,
	onChanged,
}: {
	rule: AggregationRule;
	onChanged: () => void;
}) {
	const api = useApi();
	const load = useCallback(
		() => api.api.scoring.criteria.$get().then((r) => readJson<Criteria>(r)),
		[api],
	);
	const { state, reload } = useAsync(load);
	if (state.kind === "loading") return <LoadingCard lines={6} />;
	if (state.kind === "error") {
		return (
			<ErrorState
				what="プロンプトを読み込めなかった"
				next={state.message}
				action={<Button onClick={reload}>もう一度読み込む</Button>}
			/>
		);
	}
	return (
		<PromptBody
			criteria={state.data}
			rule={rule}
			onChanged={() => {
				reload();
				onChanged();
			}}
		/>
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
}: {
	criteria: Criteria;
	rule: AggregationRule;
	onChanged: () => void;
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
				json: { criteria: draft },
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
			<p className="text-xs text-text-2">
				ニュース1件を採点するプロンプト。編集できるのは「採点の基準」だけ。版を変えても採点済みのニュースはそのままで、次に採点するニュースから新しい版で採点する。
			</p>
			<Template template={template} />
			<div className="flex items-center justify-between gap-2 text-xs">
				<label htmlFor="criteria-text" className="font-semibold">
					採点の基準 · v{activeVersion} を元に編集中
				</label>
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
			<p className="text-xs text-text-2">
				AI
				の応答がこの形式に合わない（範囲外の点数など）ときは採点に失敗として扱い、集計に入れない。
			</p>
			<div className="grid grid-cols-2 gap-3">
				<Button
					onClick={tryIt}
					disabled={trial?.kind === "running" || !draft.trim()}
				>
					最新のニュースで試す
				</Button>
				<Button
					variant="primary"
					onClick={save}
					disabled={!dirty || busy || !draft.trim()}
				>
					v{maxVersion + 1} として保存
				</Button>
			</div>
			<p className="text-xs text-text-2">
				保存しても使用中の版は変わらない。版の一覧で「使用する」を押して切り替える。
			</p>
			{message && (
				<p
					role={message.ok ? "status" : "alert"}
					className={`text-xs font-semibold ${message.ok ? "" : "text-loss"}`}
				>
					{message.text}
				</p>
			)}
			{trial && <TrialCard trial={trial} rule={rule} />}
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

function TrialCard({
	trial,
	rule,
}: {
	rule: AggregationRule;
	trial: { kind: "running" } | { kind: "done"; result: TrialResult };
}) {
	return (
		<Card className="flex flex-col gap-2">
			<span className="text-xs text-text-2">
				試し採点（保存・反映はしない）
			</span>
			{trial.kind === "running" ? (
				<>
					<Skeleton className="h-6 w-2/3" />
					<Skeleton className="h-10 w-full" />
				</>
			) : trial.result.ok ? (
				<div data-testid="trial-result" className="flex flex-col gap-2">
					<strong className="text-sm">{trial.result.news.title}</strong>
					<div className="flex flex-wrap gap-1.5">
						{JUDGES.map((j) => (
							<ScoreChip
								key={j}
								judge={j}
								score={trial.result.ok ? trial.result.scores[j] : null}
								rule={rule}
							/>
						))}
					</div>
					<p className="text-xs leading-relaxed">{trial.result.comment}</p>
				</div>
			) : (
				<p role="alert" className="text-xs font-semibold text-loss">
					試せなかった: {trial.result.message}
				</p>
			)}
		</Card>
	);
}
