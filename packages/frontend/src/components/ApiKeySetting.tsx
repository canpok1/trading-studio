import type { ApiKeyStatus } from "@trading-studio/backend";
import { useCallback, useState } from "react";
import { useApi } from "../api";
import { formatDateTime } from "../format";
import { errorMessage, readJson, useAsync } from "../lib/useAsync";
import { Modal } from "./Modal";
import { Button, Card } from "./ui";

/** Gemini の API キー。ニュースの採点とバックテストのアドバイスで使うので、設定画面の「全般」に置く */
export function ApiKeySetting() {
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
			"API キーを削除した。採点とアドバイスは止まる",
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
						削除すると、キーを保存し直すまでニュースの採点とバックテストのアドバイスが止まる。
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
