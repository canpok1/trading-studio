import type {
	EventCriteria,
	EventCriteriaVersion,
} from "@trading-studio/backend";
import { useCallback, useState } from "react";
import { Help } from "../../../shared/components/Help";
import { ErrorState, LoadingCard } from "../../../shared/components/States";
import { Button, Card } from "../../../shared/components/ui";
import { useApi } from "../../../shared/lib/api";
import { formatDateTime } from "../../../shared/lib/format";
import { errorMessage, readJson, useAsync } from "../../../shared/lib/useAsync";

/** 予定の重要度を AI に判断させるときの評価基準。版ごとに保存し、使う版を選ぶ */
export function EventCriteriaSetting() {
	const api = useApi();
	const load = useCallback(
		() =>
			api.api.calendar.criteria.$get().then((r) => readJson<EventCriteria>(r)),
		[api],
	);
	const { state, reload } = useAsync(load);
	if (state.kind === "loading") return <LoadingCard lines={6} />;
	if (state.kind === "error") {
		return (
			<ErrorState
				what="予定の評価基準を読み込めなかった"
				next={state.message}
				action={<Button onClick={reload}>もう一度読み込む</Button>}
			/>
		);
	}
	return <CriteriaBody criteria={state.data} onChanged={reload} />;
}

function CriteriaBody({
	criteria,
	onChanged,
}: {
	criteria: EventCriteria;
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
	// 保存済みのどの版とも違うときだけ保存できる。同じ内容の版を増やさないため
	const dirty = !versions.some((v) => v.text === draft.trim());

	const run = async (fn: () => Promise<string>) => {
		setBusy(true);
		setMessage(null);
		try {
			const text = await fn();
			onChanged();
			setMessage({ ok: true, text });
		} catch (e) {
			setMessage({ ok: false, text: errorMessage(e) });
		} finally {
			setBusy(false);
		}
	};
	const save = () =>
		run(async () => {
			const r = await api.api.calendar.criteria
				.$post({ json: { text: draft, note } })
				.then((res) => readJson<{ version: EventCriteriaVersion }>(res));
			setNote("");
			return `v${r.version.version} を保存した（使用中は v${activeVersion} のまま）`;
		});
	const use = (version: number) =>
		run(async () => {
			await api.api.calendar.criteria.active
				.$put({ json: { version } })
				.then((res) => readJson(res));
			const v = versions.find((x) => x.version === version);
			if (v) setDraft(v.text);
			return `v${version} を使用中にした。予定の重要度をこの版で順に判断し直す`;
		});

	const [head = "", rest = ""] = template.split("{event}");
	const [middle = "", tail = ""] = rest.split("{criteria}");
	const slot = (label: string) => (
		<mark className="rounded bg-accent px-1 font-bold text-accent-ink">
			{label}
		</mark>
	);

	return (
		<Card className="flex flex-col gap-2.5">
			<div className="flex items-center gap-1.5">
				<h2 className="text-[15px] font-bold">
					<label htmlFor="event-criteria-text">予定の評価基準</label>
				</h2>
				<Help label="予定の評価基準">
					<p>
						予定1件の重要度（高・中・低）を AI
						に判断させるプロンプト。編集できるのは評価基準だけ。判断に使うモデルはニュースの採点と同じ。
					</p>
					<p>
						保存しても使用中の版は変わらない。「使用する」で切り替えると、その版で判断していない予定を順に判断する。前の版の判断は残し、バックテストで版を選べる。
					</p>
				</Help>
				<span className="ml-auto text-xs text-text-2">
					v{activeVersion} を元に編集中 ·{" "}
					{dirty ? "未保存の変更あり" : "変更なし"}
				</span>
			</div>
			<pre className="num m-0 rounded-[10px] bg-surface-2 px-3 py-2.5 text-xs leading-relaxed whitespace-pre-wrap text-text-2">
				{head}
				{slot("{予定の取得元・日時・件名・説明}")}
				{middle}
				{slot("{評価基準}")}
				{tail}
			</pre>
			<textarea
				id="event-criteria-text"
				rows={10}
				value={draft}
				onChange={(e) => {
					setDraft(e.target.value);
					setMessage(null);
				}}
				className="num w-full rounded-lg border-[1.5px] border-accent bg-surface p-3 text-[13px] leading-relaxed"
			/>
			<div className="flex flex-col gap-1.5">
				<label htmlFor="event-criteria-note" className="text-xs font-semibold">
					版の説明（任意）
				</label>
				<input
					id="event-criteria-note"
					value={note}
					maxLength={100}
					onChange={(e) => setNote(e.target.value)}
					placeholder="画面から編集"
					className="h-11 w-full rounded-lg border border-line bg-surface px-3 text-[15px]"
				/>
			</div>
			<div className="flex justify-end">
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
			<h3 className="text-[13px] font-bold">版の履歴</h3>
			<div className="overflow-hidden rounded-xl border border-line bg-surface">
				{[...versions].reverse().map((v) => (
					<div
						key={v.version}
						data-testid={`event-criteria-v${v.version}`}
						className="flex items-center gap-2.5 border-b border-line px-3.5 py-3 last:border-b-0"
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
								<Button
									size="sm"
									disabled={busy}
									onClick={() => setDraft(v.text)}
									aria-label={`v${v.version} を編集欄に読み込む`}
								>
									読み込む
								</Button>
								<Button
									size="sm"
									disabled={busy}
									onClick={() => use(v.version)}
									aria-label={`v${v.version} を使用する`}
								>
									使用する
								</Button>
							</>
						)}
					</div>
				))}
			</div>
		</Card>
	);
}
