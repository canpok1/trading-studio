// ホームのタブ（戦略）の名前の変更・削除の確認

import type { AutoTradingStatus } from "@trading-studio/backend";
import { useId, useState } from "react";
import { Modal } from "../../../shared/components/Modal";
import { Button } from "../../../shared/components/ui";
import { useApi } from "../../../shared/lib/api";
import { errorMessage, readJson } from "../../../shared/lib/useAsync";

export function RenameRunDialog({
	run,
	onClose,
	onDone,
}: {
	run: AutoTradingStatus;
	onClose: () => void;
	onDone: () => void;
}) {
	const api = useApi();
	const id = useId();
	const [name, setName] = useState(run.name);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const save = async () => {
		setBusy(true);
		setError(null);
		try {
			await api.api.strategies[":id"].name
				.$put({ param: { id: String(run.id) }, json: { name } })
				.then((res) => readJson(res));
			onDone();
		} catch (e) {
			setError(errorMessage(e));
			setBusy(false);
		}
	};
	return (
		<Modal title="戦略の名前を変える" onClose={onClose}>
			<div className="flex flex-col gap-1.5">
				<label htmlFor={id} className="text-[13px] font-semibold">
					戦略の名前
				</label>
				<input
					id={id}
					value={name}
					onChange={(e) => setName(e.target.value)}
					className="h-12 rounded-[10px] border border-line bg-surface px-3 text-[15px]"
				/>
			</div>
			{error && (
				<p role="alert" className="text-xs font-semibold text-loss">
					{error}
				</p>
			)}
			<Button variant="primary" disabled={busy} onClick={save}>
				変える
			</Button>
			<Button onClick={onClose}>やめる</Button>
		</Modal>
	);
}

export function DeleteRunDialog({
	run,
	onClose,
	onDone,
}: {
	run: AutoTradingStatus;
	onClose: () => void;
	onDone: () => void;
}) {
	const api = useApi();
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const holding = run.account.lots.length > 0 || run.account.openOrderCount > 0;
	const remove = async () => {
		setBusy(true);
		setError(null);
		try {
			await api.api.strategies[":id"]
				.$delete({ param: { id: String(run.id) } })
				.then((res) => readJson(res));
			onDone();
		} catch (e) {
			setError(errorMessage(e));
			setBusy(false);
		}
	};
	return (
		<Modal title={`「${run.name}」を削除する`} onClose={onClose}>
			<p className="leading-relaxed">
				{holding ? "未約定の注文は取り消し、保有は捨てる。" : ""}
				条件・口座・成績は元に戻せない。過去のバックテスト結果と、注文・判断の記録（分析用のエクスポート）は残る。
			</p>
			{error && (
				<p role="alert" className="text-xs font-semibold text-loss">
					{error}
				</p>
			)}
			<Button variant="danger" disabled={busy} onClick={remove}>
				削除する
			</Button>
			<Button onClick={onClose}>やめる</Button>
		</Modal>
	);
}
