// バックテストの期間カードで、データセット（相場データを束ねたもの）を選び、作り、直す

import type { Dataset, Segment } from "@trading-studio/backend";
import {
	MARKET_REGIME_LABELS,
	MAX_DATASET_SEGMENTS,
	overlappingPairs,
	pickSpreadSegments,
} from "@trading-studio/core";
import { useId, useMemo, useState } from "react";
import { useApi } from "../../api";
import { regimeCounts, segmentMonths, segmentName } from "../../lib/segment";
import { errorMessage, readJson } from "../../lib/useAsync";
import { Modal } from "../Modal";
import { Button } from "../ui";

/** 相場ごとに選ぶ件数の選択肢 */
const PER_REGIME = [1, 2, 3] as const;

export function DatasetPicker({
	datasets,
	segments,
	selected,
	onSelect,
	onSaved,
}: {
	datasets: Dataset[];
	/** 選べる相場データ（新しい順） */
	segments: Segment[];
	selected: Dataset | null;
	onSelect: (id: number) => void;
	/** 保存・削除の後に一覧を読み直す。保存したものは id を渡して選ぶ */
	onSaved: (id: number | null) => Promise<void>;
}) {
	const selectId = useId();
	const [editing, setEditing] = useState<Dataset | "new" | null>(null);
	const overlaps = selected ? overlapText(selected.segments) : [];
	return (
		<div className="flex flex-col gap-1.5">
			{datasets.length > 0 && (
				<div className="flex flex-col gap-1">
					<label htmlFor={selectId} className="text-xs text-text-2">
						データセット
					</label>
					<select
						id={selectId}
						value={selected?.id ?? ""}
						onChange={(e) => e.target.value && onSelect(Number(e.target.value))}
						className="h-11 rounded-[10px] border border-line bg-surface px-2 text-sm"
					>
						{!selected && <option value="">選ぶ</option>}
						{datasets.map((d) => (
							<option key={d.id} value={d.id}>
								{d.name}（{d.segments.length} 件）
							</option>
						))}
					</select>
				</div>
			)}
			{selected && (
				<div className="flex flex-col gap-1 text-xs text-text-2">
					<span className="num">{regimeCounts(selected.segments)}</span>
					<ul
						aria-label="データセットの相場データ"
						className="flex flex-wrap gap-1"
					>
						{selected.segments.map((s) => (
							<li
								key={s.id}
								className="num inline-flex min-h-6 items-center rounded-md bg-surface-2 px-2 py-0.5 text-[11px] text-text"
							>
								{segmentName(s)}
							</li>
						))}
					</ul>
					{selected.missing > 0 && (
						<span className="font-semibold text-loss">
							保存した後に消えた相場データが {selected.missing}{" "}
							件ある。残りで実行する
						</span>
					)}
					{overlaps.length > 0 && <OverlapNote overlaps={overlaps} />}
				</div>
			)}
			<div className="flex flex-wrap gap-2">
				{selected && (
					<Button size="sm" onClick={() => setEditing(selected)}>
						編集
					</Button>
				)}
				<Button size="sm" onClick={() => setEditing("new")}>
					新しく作る
				</Button>
			</div>
			{editing && (
				<DatasetEditor
					dataset={editing === "new" ? null : editing}
					segments={segments}
					onClose={() => setEditing(null)}
					onSaved={async (id) => {
						await onSaved(id);
						setEditing(null);
					}}
				/>
			)}
		</div>
	);
}

/** 重なる相場データの組。例: 2026/07〜08 と 2026/08〜09 */
function overlapText(segments: readonly Segment[]): string[] {
	return overlappingPairs(segments).map(
		([i, j]) =>
			`${segmentMonths(segments[i] as Segment)} と ${segmentMonths(segments[j] as Segment)}`,
	);
}

function OverlapNote({ overlaps }: { overlaps: string[] }) {
	return (
		<span role="note" className="rounded-lg bg-warn px-2.5 py-1.5 text-text">
			期間が重なる相場データがある（{overlaps.slice(0, 3).join("、")}
			{overlaps.length > 3 && ` ほか ${overlaps.length - 3} 組`}
			）。重なった月の取引を2回数えるので、合算した成績が水増しされる
		</span>
	);
}

function DatasetEditor({
	dataset,
	segments,
	onClose,
	onSaved,
}: {
	dataset: Dataset | null;
	segments: Segment[];
	onClose: () => void;
	onSaved: (id: number | null) => Promise<void>;
}) {
	const api = useApi();
	const nameId = useId();
	const perId = useId();
	const [name, setName] = useState(dataset?.name ?? "");
	const [ids, setIds] = useState<Set<number>>(
		() => new Set(dataset?.segments.map((s) => s.id) ?? []),
	);
	const [per, setPer] = useState<number>(1);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const picked = useMemo(
		() => segments.filter((s) => ids.has(s.id)),
		[segments, ids],
	);
	const overlaps = overlapText(picked);
	const tooMany = picked.length > MAX_DATASET_SEGMENTS;

	const toggle = (id: number) => {
		const next = new Set(ids);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		setIds(next);
	};

	const save = async () => {
		setBusy(true);
		setError(null);
		const json = { name, segmentIds: picked.map((s) => s.id) };
		try {
			const res = dataset
				? await api.api.datasets[":id"].$put({
						param: { id: String(dataset.id) },
						json,
					})
				: await api.api.datasets.$post({ json });
			const r = await readJson<{ dataset: Dataset }>(res);
			await onSaved(r.dataset.id);
		} catch (e) {
			setError(errorMessage(e));
			setBusy(false);
		}
	};

	const remove = async () => {
		if (!dataset) return;
		setBusy(true);
		try {
			await api.api.datasets[":id"]
				.$delete({ param: { id: String(dataset.id) } })
				.then((r) => readJson<{ ok: true }>(r));
			await onSaved(null);
		} catch (e) {
			setError(errorMessage(e));
			setBusy(false);
		}
	};

	return (
		<Modal
			title={dataset ? "データセットを編集" : "データセットを作る"}
			onClose={onClose}
		>
			<p className="text-xs text-text-2">
				相場データを束ねて名前を付ける。実行すると、相場データごとに同じ条件でバックテストを1件ずつ実行し、成績を合算する。
			</p>
			<div className="flex flex-col gap-1">
				<label htmlFor={nameId} className="text-xs text-text-2">
					名前
				</label>
				<input
					id={nameId}
					value={name}
					onChange={(e) => setName(e.target.value)}
					className="h-11 rounded-[10px] border border-line bg-surface px-3 text-[15px]"
				/>
			</div>
			<div className="flex flex-wrap items-end gap-2">
				<div className="flex flex-col gap-1">
					<label htmlFor={perId} className="text-xs text-text-2">
						相場ごとの件数
					</label>
					<select
						id={perId}
						value={per}
						onChange={(e) => setPer(Number(e.target.value))}
						className="h-9 rounded-[10px] border border-line bg-surface px-2 text-sm"
					>
						{PER_REGIME.map((n) => (
							<option key={n} value={n}>
								{n} 件
							</option>
						))}
					</select>
				</div>
				<Button
					size="sm"
					onClick={() =>
						setIds(new Set(pickSpreadSegments(segments, per).map((s) => s.id)))
					}
				>
					重ならないように選ぶ
				</Button>
			</div>
			<p className="text-xs text-text-2">
				「重ならないように選ぶ」は、相場ごとに新しい順で、期間が重ならない相場データを選び直す。
			</p>
			<fieldset className="flex shrink-0 flex-col overflow-hidden rounded-xl border border-line">
				<legend className="sr-only">相場データ</legend>
				{segments.length === 0 && (
					<p className="px-3 py-2.5 text-xs text-text-2">
						相場データがまだ無い。
					</p>
				)}
				{segments.map((s) => (
					<label
						key={s.id}
						className="flex cursor-pointer items-center gap-2.5 border-b border-line px-3 py-2 text-sm last:border-b-0"
					>
						<input
							type="checkbox"
							className="h-4 w-4 accent-accent"
							checked={ids.has(s.id)}
							onChange={() => toggle(s.id)}
						/>
						<span className="num flex-1">{segmentMonths(s)}</span>
						<span className="text-xs text-text-2">
							{MARKET_REGIME_LABELS[s.regime]}
						</span>
					</label>
				))}
			</fieldset>
			<span className="num text-xs text-text-2">
				{picked.length} 件を選択中
				{picked.length > 0 && ` · ${regimeCounts(picked)}`}
			</span>
			{overlaps.length > 0 && (
				<div className="text-xs">
					<OverlapNote overlaps={overlaps} />
				</div>
			)}
			{tooMany && (
				<span className="text-xs font-semibold text-loss">
					相場データは {MAX_DATASET_SEGMENTS} 件までにする
				</span>
			)}
			{error && (
				<p role="alert" className="text-xs font-semibold text-loss">
					{error}
				</p>
			)}
			<div className="flex flex-wrap items-center gap-2">
				<Button
					variant="primary"
					disabled={
						busy || name.trim() === "" || picked.length === 0 || tooMany
					}
					onClick={save}
				>
					保存
				</Button>
				<Button onClick={onClose}>やめる</Button>
				{dataset &&
					(confirmDelete ? (
						<Button
							variant="danger"
							className="ml-auto"
							disabled={busy}
							onClick={remove}
						>
							本当に消す
						</Button>
					) : (
						<Button
							variant="link"
							className="ml-auto"
							onClick={() => setConfirmDelete(true)}
						>
							消す
						</Button>
					))}
			</div>
			{confirmDelete && (
				<p className="text-xs text-text-2">
					データセットを消しても、これまでの実行の結果は残る。
				</p>
			)}
		</Modal>
	);
}
