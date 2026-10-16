// 戦略を作る・名前を変える・削除する確認

import type {
	AutoTradingStatus,
	StoredStrategy,
} from "@trading-studio/backend";
import type { TemplateId } from "@trading-studio/core";
import { strategyTemplate, TEMPLATE_IDS } from "@trading-studio/core";
import { useId, useState } from "react";
import { Modal } from "../../../shared/components/Modal";
import { Button } from "../../../shared/components/ui";
import { useApi } from "../../../shared/lib/api";
import { errorMessage, readJson } from "../../../shared/lib/useAsync";

function NameField({
	value,
	onChange,
	error,
	label,
}: {
	value: string;
	onChange: (v: string) => void;
	error: string | null;
	label: string;
}) {
	const id = useId();
	return (
		<div className="flex flex-col gap-1.5">
			<label htmlFor={id} className="text-[13px] font-semibold">
				{label}
			</label>
			<input
				id={id}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				aria-invalid={error ? true : undefined}
				className="h-12 rounded-[10px] border border-line bg-surface px-3 text-[15px] aria-invalid:border-2 aria-invalid:border-loss"
			/>
			{error && (
				<span role="alert" className="text-xs font-semibold text-loss">
					{error}
				</span>
			)}
		</div>
	);
}

/** ひな形から、または copyFrom を複製して戦略を作る */
export function CreateStrategyDialog({
	copyFrom,
	onClose,
	onCreated,
}: {
	copyFrom: { id: number; name: string } | null;
	onClose: () => void;
	onCreated: (s: StoredStrategy) => void;
}) {
	const api = useApi();
	const [name, setName] = useState(
		copyFrom ? `${copyFrom.name}のコピー` : "新しい戦略",
	);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const create = async (
		from: { template: TemplateId } | { copyOf: number },
	) => {
		setBusy(true);
		try {
			const r = await api.api.strategies
				.$post({ json: { name, from } })
				.then((res) => readJson<{ strategy: StoredStrategy }>(res));
			onCreated(r.strategy);
		} catch (e) {
			setError(errorMessage(e));
			setBusy(false);
		}
	};
	const options: [string, string, () => void][] = copyFrom
		? [
				[
					`「${copyFrom.name}」を複製`,
					"保存済みの条件をそのまま写す。口座と成績は写さない。",
					() => create({ copyOf: copyFrom.id }),
				],
			]
		: TEMPLATE_IDS.map((t): [string, string, () => void] => {
				const tpl = strategyTemplate(t);
				return [
					t === "blank" ? tpl.name : `${tpl.name}（ひな形）`,
					tpl.description,
					() => create({ template: t }),
				];
			});
	return (
		<Modal title={copyFrom ? "戦略を複製する" : "新しい戦略"} onClose={onClose}>
			<NameField
				label="名前"
				value={name}
				onChange={(v) => {
					setName(v);
					setError(null);
				}}
				error={error}
			/>
			<span className="text-xs text-text-2">何から作るか</span>
			<div className="overflow-hidden rounded-xl border border-line">
				{options.map(([label, desc, run]) => (
					<button
						key={label}
						type="button"
						disabled={busy}
						onClick={run}
						className="flex w-full flex-col gap-0.5 border-b border-line px-4 py-3 text-left last:border-b-0 hover:bg-surface-2 disabled:opacity-45"
					>
						<strong className="text-sm">{label}</strong>
						<span className="text-xs text-text-2">{desc}</span>
					</button>
				))}
			</div>
			<Button onClick={onClose}>やめる</Button>
		</Modal>
	);
}

export function RenameStrategyDialog({
	run,
	onClose,
	onDone,
}: {
	run: AutoTradingStatus;
	onClose: () => void;
	onDone: () => void;
}) {
	const api = useApi();
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
			<NameField
				label="戦略の名前"
				value={name}
				onChange={(v) => {
					setName(v);
					setError(null);
				}}
				error={error}
			/>
			<Button variant="primary" disabled={busy} onClick={save}>
				変える
			</Button>
			<Button onClick={onClose}>やめる</Button>
		</Modal>
	);
}

export function DeleteStrategyDialog({
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
