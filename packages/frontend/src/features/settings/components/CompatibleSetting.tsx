import type {
	CompatibleConnectionStatus,
	CompatibleModelsResult,
} from "@trading-studio/backend";
import { useCallback, useEffect, useState } from "react";
import { Help } from "../../../shared/components/Help";
import { Modal } from "../../../shared/components/Modal";
import { Button, Card } from "../../../shared/components/ui";
import { useApi } from "../../../shared/lib/api";
import { formatDateTime } from "../../../shared/lib/format";
import { errorMessage, readJson, useAsync } from "../../../shared/lib/useAsync";

type Message = { ok: boolean; text: string } | null;

/** OpenAI 互換の接続先（Bifrost などの集約サービス）。採点・アドバイスでそのモデルを選んだときに使う */
export function CompatibleSetting() {
	const api = useApi();
	const load = useCallback(
		() =>
			api.api.ai.compatible
				.$get()
				.then((r) => readJson<CompatibleConnectionStatus>(r)),
		[api],
	);
	const { state, reload } = useAsync(load);
	const [url, setUrl] = useState("");
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [message, setMessage] = useState<Message>(null);
	const saved = state.kind === "ok" ? state.data : null;
	useEffect(() => {
		if (saved) setUrl(saved.baseUrl ?? "");
	}, [saved]);

	const act = async (fn: () => Promise<Message>) => {
		setBusy(true);
		setMessage(null);
		try {
			setMessage(await fn());
		} catch (e) {
			setMessage({ ok: false, text: errorMessage(e) });
		} finally {
			setBusy(false);
		}
	};
	const save = () =>
		act(async () => {
			await api.api.ai.compatible
				.$put({
					// 空なら保存済みのキーを残す（URL を変えたときは backend が消す）
					json: { baseUrl: url, apiKey: key.trim() ? key : undefined },
				})
				.then((r) => readJson(r));
			setKey("");
			reload();
			return { ok: true, text: "接続先を保存した" };
		});
	const check = () =>
		act(async () => {
			const r = await api.api.ai.compatible.models
				.$get()
				.then((res) => readJson<CompatibleModelsResult>(res));
			return r.ok
				? { ok: true, text: `つながった（モデル ${r.models.length} 件）` }
				: { ok: false, text: r.message };
		});
	const remove = () =>
		act(async () => {
			await api.api.ai.compatible.$delete().then((r) => readJson(r));
			setKey("");
			reload();
			return {
				ok: true,
				text: "接続先を削除した。OpenAI 互換のモデルを選んでいる採点・アドバイスは止まる",
			};
		});

	const dirty =
		saved !== null &&
		url.trim() !== "" &&
		(url.trim() !== (saved.baseUrl ?? "") || key.trim() !== "");

	return (
		<Card className="flex flex-col gap-2.5">
			<div className="flex items-center gap-1.5">
				<h2 className="text-[15px] font-bold">OpenAI 互換の接続先</h2>
				<Help label="OpenAI 互換の接続先">
					<p>
						Bifrost などの集約サービスを OpenAI 互換 API
						で使う。ここで設定すると、採点とアドバイスのモデルの選択欄に接続先のモデルが並ぶ。キーは保存しても画面に出さない。URL
						を変えると保存済みのキーは消えるので、要るなら入れ直す。
					</p>
				</Help>
			</div>
			{state.kind === "error" ? (
				<p role="alert" className="text-xs font-semibold text-loss">
					読み込めなかった: {state.message}
				</p>
			) : (
				<>
					<p data-testid="compatible-state" className="num text-sm">
						{!saved
							? "読み込み中"
							: saved.baseUrl === null
								? "未設定"
								: saved.keyConfigured
									? `設定済み（キー保存: ${saved.keySavedAt === null ? "日時不明" : formatDateTime(saved.keySavedAt)}）`
									: "設定済み（キーなし）"}
					</p>
					<label className="flex flex-col gap-1 text-sm">
						URL
						<input
							type="url"
							inputMode="url"
							autoComplete="off"
							spellCheck={false}
							value={url}
							placeholder="http://<サーバー>:8080/v1"
							onChange={(e) => {
								setUrl(e.target.value);
								setMessage(null);
							}}
							className="num h-11 min-w-0 rounded-lg border border-line bg-surface px-3 text-[15px]"
						/>
					</label>
					<label className="flex flex-col gap-1 text-sm">
						API キー
						<input
							type="password"
							autoComplete="off"
							spellCheck={false}
							value={key}
							placeholder={
								saved?.keyConfigured
									? "変えるときだけ入れる"
									: "接続先がキーを求めるときだけ入れる"
							}
							onChange={(e) => {
								setKey(e.target.value);
								setMessage(null);
							}}
							className="h-11 min-w-0 rounded-lg border border-line bg-surface px-3 text-[15px]"
						/>
					</label>
					<div className="flex flex-wrap gap-2">
						<Button size="sm" disabled={busy || !dirty} onClick={save}>
							保存
						</Button>
						<Button
							size="sm"
							disabled={busy || saved?.baseUrl == null}
							onClick={check}
						>
							接続を確かめる
						</Button>
						{saved?.baseUrl != null && (
							<Button
								size="sm"
								variant="danger"
								disabled={busy}
								onClick={() => setDeleting(true)}
							>
								接続先を削除
							</Button>
						)}
					</div>
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
			{deleting && (
				<Modal title="接続先を削除する" onClose={() => setDeleting(false)}>
					<p className="text-sm">
						URL とキーを消す。OpenAI
						互換のモデルを選んでいる採点・アドバイスは、設定し直すまで止まる。
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
