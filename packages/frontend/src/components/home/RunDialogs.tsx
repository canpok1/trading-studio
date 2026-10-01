// ホームのタブ（運用）の追加・名前の変更・削除の確認

import type {
	AutoTradingStatus,
	StoredStrategy,
	TradingMode,
} from "@trading-studio/backend";
import { TRADING_RUN_LIMITS, validateConditionSet } from "@trading-studio/core";
import { useId, useState } from "react";
import { useApi } from "../../api";
import { errorMessage, readJson } from "../../lib/useAsync";
import { Modal } from "../Modal";
import { MODE_LABELS } from "../trading/TradeViews";
import { Button, Tabs } from "../ui";

const MODES: readonly (readonly [TradingMode, string])[] = [
	["paper", MODE_LABELS.paper],
	["live", MODE_LABELS.live],
];

function NameField({
	value,
	onChange,
}: {
	value: string;
	onChange: (v: string) => void;
}) {
	const id = useId();
	return (
		<div className="flex flex-col gap-1.5">
			<label htmlFor={id} className="text-[13px] font-semibold">
				タブの名前
			</label>
			<input
				id={id}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				maxLength={TRADING_RUN_LIMITS.name}
				className="h-12 rounded-[10px] border border-line bg-surface px-3 text-[15px]"
			/>
		</div>
	);
}

/** 名前は、自分で書き換えるまで選んだ戦略の名前に合わせる */
export function AddRunDialog({
	strategies,
	hasLive,
	onClose,
	onCreated,
}: {
	strategies: StoredStrategy[];
	/** ライブのタブは1つまで */
	hasLive: boolean;
	onClose: () => void;
	onCreated: (s: AutoTradingStatus) => void;
}) {
	const api = useApi();
	const strategyId = useId();
	// 条件が足りない戦略は動かせないので選ばせない
	const usable = strategies.filter(
		(s) => validateConditionSet(s.params).length === 0,
	);
	const [mode, setMode] = useState<TradingMode>("paper");
	const [strategy, setStrategy] = useState<StoredStrategy | null>(
		usable[0] ?? null,
	);
	const [name, setName] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// 戦略の名前はタブの名前より長くてよいので、収まる長さに切る
	const shownName =
		name ??
		(strategy?.name ?? MODE_LABELS[mode]).slice(0, TRADING_RUN_LIMITS.name);
	const add = async () => {
		setBusy(true);
		setError(null);
		try {
			const r = await api.api.trading.runs
				.$post({
					json: { name: shownName, mode, strategyId: strategy?.id ?? null },
				})
				.then((res) => readJson<{ status: AutoTradingStatus }>(res));
			onCreated(r.status);
		} catch (e) {
			setError(errorMessage(e));
			setBusy(false);
		}
	};
	return (
		<Modal title="タブを追加する" onClose={onClose}>
			<div className="flex flex-col gap-1.5">
				<span className="text-[13px] font-semibold">モード</span>
				<Tabs label="モード" items={MODES} current={mode} onSelect={setMode} />
				{mode === "live" && (
					<span className="text-xs text-text-2">
						{hasLive
							? "ライブのタブは1つまで（実口座は1つのため）"
							: "ライブ取引はまだ使えない。タブは作れるが動かせない"}
					</span>
				)}
			</div>
			<div className="flex flex-col gap-1.5">
				<label htmlFor={strategyId} className="text-[13px] font-semibold">
					運用する戦略
				</label>
				<select
					id={strategyId}
					className="h-11 w-full rounded-lg border border-line bg-surface px-3 text-[15px] font-semibold"
					value={strategy?.id ?? ""}
					onChange={(e) =>
						setStrategy(
							usable.find((s) => s.id === Number(e.target.value)) ?? null,
						)
					}
				>
					<option value="">未選択</option>
					{usable.map((s) => (
						<option key={s.id} value={s.id}>
							{s.name}
						</option>
					))}
				</select>
			</div>
			<NameField value={shownName} onChange={setName} />
			{error && (
				<p role="alert" className="text-xs font-semibold text-loss">
					{error}
				</p>
			)}
			<Button
				variant="primary"
				disabled={busy || (mode === "live" && hasLive)}
				onClick={add}
			>
				追加する
			</Button>
			<Button onClick={onClose}>やめる</Button>
		</Modal>
	);
}

export function RenameRunDialog({
	run,
	onClose,
	onDone,
}: {
	run: AutoTradingStatus;
	onClose: () => void;
	onDone: (s: AutoTradingStatus) => void;
}) {
	const api = useApi();
	const [name, setName] = useState(run.name);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const save = async () => {
		setBusy(true);
		setError(null);
		try {
			const r = await api.api.trading.runs[":id"]
				.$patch({ param: { id: String(run.id) }, json: { name } })
				.then((res) => readJson<{ status: AutoTradingStatus }>(res));
			onDone(r.status);
		} catch (e) {
			setError(errorMessage(e));
			setBusy(false);
		}
	};
	return (
		<Modal title="タブの名前を変える" onClose={onClose}>
			<NameField value={name} onChange={setName} />
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
			await api.api.trading.runs[":id"]
				.$delete({ param: { id: String(run.id) } })
				.then((res) => readJson(res));
			onDone();
		} catch (e) {
			setError(errorMessage(e));
			setBusy(false);
		}
	};
	return (
		<Modal title={`「${run.name}」のタブを削除する`} onClose={onClose}>
			<p className="leading-relaxed">
				{holding ? "未約定の注文は取り消し、保有は捨てる。" : ""}
				タブの口座と成績は見られなくなる。注文と判断の記録は分析用のエクスポートに残る。
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
