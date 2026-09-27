import type {
	AdviceModelOption,
	InstructionsVersion,
} from "@trading-studio/backend";
import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../api";
import { formatDateTime } from "../../format";
import { errorMessage, readJson, useAsync } from "../../lib/useAsync";
import { ErrorState, LoadingCard } from "../States";
import { Button, Card } from "../ui";

/** 設定画面の「バックテスト」区分。AI アドバイスに使うモデルと指示 */
export function AdviceSettings() {
	return (
		<>
			<AdviceModelSetting />
			<InstructionsSetting />
		</>
	);
}

type Message = { ok: boolean; text: string } | null;

function MessageLine({ message }: { message: Message }) {
	if (!message) return null;
	return (
		<p
			role={message.ok ? "status" : "alert"}
			className={`text-xs font-semibold ${message.ok ? "" : "text-loss"}`}
		>
			{message.text}
		</p>
	);
}

function AdviceModelSetting() {
	const api = useApi();
	const load = useCallback(
		() =>
			api.api.advice.model
				.$get()
				.then((r) =>
					readJson<{ models: AdviceModelOption[]; current: string }>(r),
				),
		[api],
	);
	const { state, reload } = useAsync(load);
	const [value, setValue] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<Message>(null);
	const current = state.kind === "ok" ? state.data.current : null;
	useEffect(() => {
		if (current !== null) setValue(current);
	}, [current]);

	const save = async () => {
		if (value === null) return;
		setBusy(true);
		setMessage(null);
		try {
			await api.api.advice.model
				.$put({ json: { model: value } })
				.then((r) => readJson(r));
			setMessage({
				ok: true,
				text: "モデルを保存した。次に作るアドバイスから反映する",
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
			<h2 className="text-[15px] font-bold">
				<label htmlFor="advice-model">アドバイスに使うモデル</label>
			</h2>
			{state.kind === "error" ? (
				<p role="alert" className="text-xs font-semibold text-loss">
					読み込めなかった: {state.message}
				</p>
			) : (
				<div className="flex items-center gap-2">
					<select
						id="advice-model"
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
			<MessageLine message={message} />
			<p className="text-xs text-text-2">
				API キーはニュースの採点と共用（設定の「全般」）。
			</p>
		</Card>
	);
}

type Instructions = {
	versions: InstructionsVersion[];
	activeVersion: number | null;
	template: string;
};

function InstructionsSetting() {
	const api = useApi();
	const load = useCallback(
		() =>
			api.api.advice.instructions.$get().then((r) => readJson<Instructions>(r)),
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
	return <InstructionsBody data={state.data} onChanged={reload} />;
}

function Template({ template }: { template: string }) {
	// 差し込む場所を目立たせる。ひな形は {backtest} → {instructions} の順に1回ずつ含む
	const [head = "", rest = ""] = template.split("{backtest}");
	const [middle = "", tail = ""] = rest.split("{instructions}");
	const slot = (label: string) => (
		<mark className="rounded bg-accent px-1 font-bold text-accent-ink">
			{label}
		</mark>
	);
	return (
		<div className="flex flex-col gap-1.5 rounded-[10px] bg-surface-2 px-3 py-2.5">
			<span className="text-[11px] font-bold text-text-2">
				固定のひな形（編集不可）· 出力の見出しは画面の前提
			</span>
			<pre className="num m-0 text-xs leading-relaxed whitespace-pre-wrap text-text-2">
				{head}
				{slot("{条件・成績・注文・値動き}")}
				{middle}
				{slot("{指示}")}
				{tail}
			</pre>
		</div>
	);
}

function InstructionsBody({
	data,
	onChanged,
}: {
	data: Instructions;
	onChanged: () => void;
}) {
	const api = useApi();
	const { versions, activeVersion, template } = data;
	const active = versions.find((v) => v.version === activeVersion) ?? null;
	const maxVersion = Math.max(0, ...versions.map((v) => v.version));
	const [draft, setDraft] = useState(active?.text ?? "");
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<Message>(null);
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
			const r = await api.api.advice.instructions
				.$post({ json: { text: draft, note } })
				.then((res) => readJson<{ version: InstructionsVersion }>(res));
			setNote("");
			return `v${r.version.version} を保存した（使用中は v${activeVersion} のまま）`;
		});

	const use = (version: number) =>
		run(async () => {
			await api.api.advice.instructions.active
				.$put({ json: { version } })
				.then((res) => readJson(res));
			const v = versions.find((x) => x.version === version);
			if (v) setDraft(v.text);
			return `v${version} を使用中にした。次に作るアドバイスから反映する`;
		});

	return (
		<Card className="flex flex-col gap-2.5">
			<h2 className="text-[15px] font-bold">アドバイスのプロンプト</h2>
			<p className="text-xs text-text-2">
				バックテスト結果の分析と改善案を作るプロンプト。編集できるのは「指示」だけ。版を変えても作成済みのアドバイスはそのままで、次に作るアドバイスから新しい版を使う。
			</p>
			<Template template={template} />
			<div className="flex items-center justify-between gap-2 text-xs">
				<label htmlFor="advice-instructions" className="font-semibold">
					指示 · v{activeVersion} を元に編集中
				</label>
				<span className="text-text-2">
					{dirty ? "未保存の変更あり" : "変更なし"}
				</span>
			</div>
			<textarea
				id="advice-instructions"
				rows={6}
				value={draft}
				onChange={(e) => {
					setDraft(e.target.value);
					setMessage(null);
				}}
				className="num w-full rounded-lg border-[1.5px] border-accent bg-surface p-3 text-[13px] leading-relaxed"
			/>
			<div className="flex flex-col gap-1.5">
				<label htmlFor="advice-note" className="text-xs font-semibold">
					版の説明（任意）
				</label>
				<input
					id="advice-note"
					value={note}
					maxLength={100}
					onChange={(e) => setNote(e.target.value)}
					placeholder="画面から編集"
					className="h-11 w-full rounded-lg border border-line bg-surface px-3 text-[15px]"
				/>
			</div>
			<Button
				variant="primary"
				onClick={save}
				disabled={!dirty || busy || !draft.trim()}
			>
				v{maxVersion + 1} として保存
			</Button>
			<p className="text-xs text-text-2">
				保存しても使用中の版は変わらない。版の一覧で「使用する」を押して切り替える。
			</p>
			<MessageLine message={message} />
			<h3 className="text-[13px] font-bold">版の履歴</h3>
			<div className="overflow-hidden rounded-xl border border-line">
				{[...versions].reverse().map((v) => (
					<div
						key={v.version}
						data-testid={`instructions-v${v.version}`}
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
							<Button size="sm" disabled={busy} onClick={() => use(v.version)}>
								使用する
							</Button>
						)}
					</div>
				))}
			</div>
		</Card>
	);
}
