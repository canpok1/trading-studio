import type {
	ApiKeyStatus,
	NewsCollectorStatus,
	NewsSource,
	ScoringModelOption,
} from "@trading-studio/backend";
import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../api";
import { formatDateTime } from "../../format";
import { errorMessage, readJson, useAsync } from "../../lib/useAsync";
import { Modal } from "../Modal";
import { NumberInput } from "../NumberInput";
import { Button, Card } from "../ui";

const INTERVAL = { min: 5, max: 1440 };
const LANGUAGES = [
	["ja", "日本語"],
	["en", "英語"],
] as const;

export function SourcesTab({
	collector,
	onChanged,
}: {
	collector: NewsCollectorStatus;
	onChanged: () => void;
}) {
	return (
		<>
			<SourceList sources={collector.sources} onChanged={onChanged} />
			<AddSource onChanged={onChanged} />
			<IntervalSetting
				saved={collector.intervalMinutes}
				nextRunAt={collector.nextRunAt}
				onChanged={onChanged}
			/>
			<ApiKeySetting onChanged={onChanged} />
			<ModelSetting />
		</>
	);
}

function SourceList({
	sources,
	onChanged,
}: {
	sources: NewsSource[];
	onChanged: () => void;
}) {
	const api = useApi();
	const [busy, setBusy] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [removing, setRemoving] = useState<NewsSource | null>(null);

	const act = async (id: number, fn: () => Promise<unknown>) => {
		setBusy(id);
		setError(null);
		try {
			await fn();
			onChanged();
		} catch (e) {
			setError(errorMessage(e));
		} finally {
			setBusy(null);
		}
	};
	const toggle = (s: NewsSource) =>
		act(s.id, () =>
			api.api.news.sources[":id"]
				.$patch({ param: { id: String(s.id) }, json: { enabled: !s.enabled } })
				.then((r) => readJson(r)),
		);
	const remove = (s: NewsSource) =>
		act(s.id, () =>
			api.api.news.sources[":id"]
				.$delete({ param: { id: String(s.id) } })
				.then((r) => readJson(r)),
		);

	return (
		<section className="flex flex-col gap-2">
			<h2 className="text-[15px] font-bold">ニュースの取得元（RSS）</h2>
			{sources.length === 0 ? (
				<p className="text-xs text-text-2">
					取得元が無い。下の「取得元を追加」から追加する
				</p>
			) : (
				<div className="overflow-hidden rounded-xl border border-line bg-surface">
					{sources.map((s) => (
						<div
							key={s.id}
							data-testid="news-source"
							className="flex items-center gap-3 border-b border-line px-3.5 py-3 last:border-b-0"
						>
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="text-sm font-semibold">
									{s.name}{" "}
									<span className="text-xs font-normal text-text-2">
										{s.language === "ja" ? "日本語" : "英語"}
									</span>
								</span>
								<span className="truncate text-xs text-text-2">{s.url}</span>
								<span className="num text-xs text-text-2">
									{s.lastError
										? ""
										: s.lastSuccessAt === null
											? "まだ取得していない"
											: `最後に取得: ${formatDateTime(s.lastSuccessAt)}`}
								</span>
								{s.lastError && (
									<span className="text-xs font-semibold text-loss">
										{s.lastError}
									</span>
								)}
							</div>
							<button
								type="button"
								role="switch"
								aria-checked={s.enabled}
								aria-label={`${s.name} から集める`}
								disabled={busy === s.id}
								onClick={() => toggle(s)}
								className="flex h-8 w-14 shrink-0 items-center rounded-full bg-surface-2 p-[3px] transition-colors aria-checked:bg-accent disabled:opacity-60"
							>
								<span
									className={`h-[26px] w-[26px] rounded-full bg-white shadow transition-transform ${s.enabled ? "translate-x-6" : ""}`}
								/>
							</button>
							<Button
								size="sm"
								disabled={busy === s.id}
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
					変更できなかった: {error}
				</p>
			)}
			<p className="text-xs text-text-2">
				無効にした取得元は次の収集から取らない。削除しても集めたニュースと採点は残る。
			</p>
			{removing && (
				<Modal title="取得元を削除する" onClose={() => setRemoving(null)}>
					<p className="text-sm">
						「{removing.name}
						」を削除する。集めたニュースと採点は残る。
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
		</section>
	);
}

function AddSource({ onChanged }: { onChanged: () => void }) {
	const api = useApi();
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [language, setLanguage] = useState<"ja" | "en">("ja");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<{
		field?: string;
		message: string;
	} | null>(null);

	const add = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await api.api.news.sources.$post({
				json: { name, url, language },
			});
			if (!res.ok) {
				const body = (await res.json()) as { message: string; field?: string };
				setError(body);
				return;
			}
			setName("");
			setUrl("");
			onChanged();
		} catch (e) {
			setError({ message: errorMessage(e) });
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card className="flex flex-col gap-2.5">
			<h2 className="text-[15px] font-bold">取得元を追加</h2>
			<div className="flex flex-col gap-1.5">
				<label htmlFor="source-name" className="text-[13px] font-semibold">
					名前
				</label>
				<input
					id="source-name"
					value={name}
					maxLength={40}
					onChange={(e) => setName(e.target.value)}
					aria-invalid={error?.field === "name" || undefined}
					className="h-11 w-full rounded-lg border border-line bg-surface px-3 text-[15px] aria-invalid:border-2 aria-invalid:border-loss"
				/>
			</div>
			<div className="flex flex-col gap-1.5">
				<label htmlFor="source-url" className="text-[13px] font-semibold">
					RSS の URL
				</label>
				<input
					id="source-url"
					type="url"
					inputMode="url"
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					placeholder="https://"
					aria-invalid={error?.field === "url" || undefined}
					className="h-11 w-full rounded-lg border border-line bg-surface px-3 text-[15px] aria-invalid:border-2 aria-invalid:border-loss"
				/>
			</div>
			<div className="flex flex-col gap-1.5">
				<label htmlFor="source-language" className="text-[13px] font-semibold">
					言語
				</label>
				<select
					id="source-language"
					value={language}
					onChange={(e) => setLanguage(e.target.value as "ja" | "en")}
					className="h-11 w-full rounded-lg border border-line bg-surface px-3 text-[15px]"
				>
					{LANGUAGES.map(([v, l]) => (
						<option key={v} value={v}>
							{l}
						</option>
					))}
				</select>
			</div>
			{error && (
				<p role="alert" className="text-xs font-semibold text-loss">
					追加できなかった: {error.message}
				</p>
			)}
			<Button
				variant="primary"
				disabled={busy || !name.trim() || !url.trim()}
				onClick={add}
			>
				追加する
			</Button>
			<p className="text-xs text-text-2">
				利用規約で自動取得や AI
				への入力が禁止されていないかを確かめてから追加する。
			</p>
		</Card>
	);
}

function IntervalSetting({
	saved,
	nextRunAt,
	onChanged,
}: {
	saved: number;
	nextRunAt: number | null;
	onChanged: () => void;
}) {
	const api = useApi();
	const [value, setValue] = useState(saved);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
		null,
	);
	const valid =
		Number.isInteger(value) && value >= INTERVAL.min && value <= INTERVAL.max;
	const save = async () => {
		setBusy(true);
		setMessage(null);
		try {
			await api.api.news.settings
				.$put({ json: { intervalMinutes: value } })
				.then((r) => readJson(r));
			setMessage({
				ok: true,
				text: "収集間隔を保存した。次の収集から反映する",
			});
			onChanged();
		} catch (e) {
			setMessage({ ok: false, text: errorMessage(e) });
		} finally {
			setBusy(false);
		}
	};
	return (
		<Card className="flex flex-col gap-2.5">
			<h2 className="text-[15px] font-bold">収集間隔</h2>
			<div className="flex flex-wrap items-center gap-2">
				<NumberInput
					id="news-interval"
					aria-label="収集間隔（分）"
					inputMode="numeric"
					value={value}
					onChange={(v) => {
						setValue(v);
						setMessage(null);
					}}
					invalid={!valid}
					className="w-[76px]"
				/>
				<span>分ごと</span>
				<Button
					size="sm"
					disabled={!valid || value === saved || busy}
					onClick={save}
				>
					保存
				</Button>
			</div>
			{!valid && (
				<p className="text-xs font-semibold text-loss">
					{INTERVAL.min}〜{INTERVAL.max} の整数で入れる
				</p>
			)}
			{message && (
				<p
					role={message.ok ? "status" : "alert"}
					className={`text-xs font-semibold ${message.ok ? "" : "text-loss"}`}
				>
					{message.text}
				</p>
			)}
			{nextRunAt !== null && (
				<span className="num text-xs text-text-2">
					次の収集: {formatDateTime(nextRunAt)}
				</span>
			)}
		</Card>
	);
}

function ApiKeySetting({ onChanged }: { onChanged: () => void }) {
	const api = useApi();
	const load = useCallback(
		() =>
			api.api.scoring["api-key"].$get().then((r) => readJson<ApiKeyStatus>(r)),
		[api],
	);
	const { state, reload } = useAsync(load);
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
		null,
	);
	const configured = state.kind === "ok" && state.data.configured;

	const act = async (fn: () => Promise<unknown>, done: string) => {
		setBusy(true);
		setMessage(null);
		try {
			await fn();
			setValue("");
			setMessage({ ok: true, text: done });
			reload();
			onChanged();
		} catch (e) {
			setMessage({ ok: false, text: errorMessage(e) });
		} finally {
			setBusy(false);
		}
	};
	const save = () =>
		act(
			() =>
				api.api.scoring["api-key"]
					.$put({ json: { key: value } })
					.then((r) => readJson(r)),
			"API キーを保存した",
		);
	const remove = () =>
		act(
			() => api.api.scoring["api-key"].$delete().then((r) => readJson(r)),
			"API キーを削除した。採点は止まる",
		);

	return (
		<Card className="flex flex-col gap-2.5">
			<h2 className="text-[15px] font-bold">
				<label htmlFor="gemini-api-key">Gemini の API キー</label>
			</h2>
			{state.kind === "error" ? (
				<p role="alert" className="text-xs font-semibold text-loss">
					読み込めなかった: {state.message}
				</p>
			) : (
				<>
					<p data-testid="api-key-state" className="num text-sm">
						{state.kind !== "ok"
							? "読み込み中"
							: state.data.configured
								? `設定済み${state.data.savedAt === null ? "" : `（保存: ${formatDateTime(state.data.savedAt)}）`}`
								: "未設定"}
					</p>
					<div className="flex items-center gap-2">
						<input
							id="gemini-api-key"
							type="password"
							autoComplete="off"
							spellCheck={false}
							value={value}
							placeholder={
								configured ? "新しいキーで上書きする" : "キーを入れる"
							}
							onChange={(e) => {
								setValue(e.target.value);
								setMessage(null);
							}}
							className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-[15px]"
						/>
						<Button
							size="sm"
							disabled={busy || state.kind !== "ok" || value.trim() === ""}
							onClick={save}
						>
							{configured ? "上書き" : "保存"}
						</Button>
					</div>
					{configured && (
						<Button
							size="sm"
							variant="danger"
							disabled={busy}
							onClick={() => setDeleting(true)}
							className="self-start"
						>
							キーを削除
						</Button>
					)}
				</>
			)}
			{message && (
				<p
					role={message.ok ? "status" : "alert"}
					className={`text-xs font-semibold ${message.ok ? "" : "text-loss"}`}
				>
					{message.text}
				</p>
			)}
			<p className="text-xs text-text-2">
				保存したキーは画面に出さない。変えるときは上書きする。無料枠のキーだと記事が学習に使われるので、有料枠のキーを使う。
			</p>
			{deleting && (
				<Modal title="API キーを削除する" onClose={() => setDeleting(false)}>
					<p className="text-sm">
						削除すると、キーを保存し直すまで採点が止まる。
					</p>
					<div className="grid grid-cols-2 gap-3">
						<Button onClick={() => setDeleting(false)}>やめる</Button>
						<Button
							variant="danger"
							onClick={() => {
								setDeleting(false);
								remove();
							}}
						>
							削除する
						</Button>
					</div>
				</Modal>
			)}
		</Card>
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
			<h2 className="text-[15px] font-bold">
				<label htmlFor="scoring-model">採点に使うモデル</label>
			</h2>
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
			<p className="text-xs text-text-2">
				モデルを変えても採点済みのニュースは採点し直さない。
			</p>
		</Card>
	);
}
