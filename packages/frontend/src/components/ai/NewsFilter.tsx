import type { NewsImpact } from "@trading-studio/backend";
import { DURATION_LABELS, DURATIONS } from "@trading-studio/core";
import { useEffect, useId, useRef, useState } from "react";
import type { NewsFilterState, NewsPeriod } from "../../lib/news-filter";
import {
	activeFilterCount,
	customRangeError,
	customRangeLabel,
	EMPTY_FILTER,
	IMPACT_LABELS,
	NEWS_PERIODS,
	PERIOD_LABELS,
	SORT_LABELS,
} from "../../lib/news-filter";
import { FilterIcon, SearchIcon } from "../icons";
import { Modal } from "../Modal";
import { Button, Segmented } from "../ui";

/** キーワードを打ち終えてから問い合わせるまでの待ち */
const TYPING_MS = 400;

const IMPACTS = Object.keys(IMPACT_LABELS) as NewsImpact[];
const ACTIVE_LABEL = "評価に使用中";

const toggle = <T,>(list: readonly T[], v: T) =>
	list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

/** 検索欄・「絞り込み」ボタン・よく使う条件のチップ */
export function NewsFilterBar({
	filter,
	onChange,
}: {
	filter: NewsFilterState;
	onChange: (f: NewsFilterState) => void;
}) {
	const [q, setQ] = useState(filter.q);
	const [open, setOpen] = useState(false);
	// 自分で書いたキーワード。URL がこれ以外に変わったとき（戻る など）だけ欄を合わせ、打っている途中の文字を消さない
	const written = useRef(filter.q);
	useEffect(() => {
		if (filter.q !== written.current) {
			written.current = filter.q;
			setQ(filter.q);
		}
	}, [filter.q]);
	useEffect(() => {
		// 空白だけのキーワードは URL に書かないので、前後の空白を除いて比べる
		if (q.trim() === filter.q.trim()) return;
		const id = setTimeout(() => {
			written.current = q;
			onChange({ ...filter, q });
		}, TYPING_MS);
		return () => clearTimeout(id);
	}, [q, filter, onChange]);

	const count = activeFilterCount(filter);
	const setPeriod = (period: NewsPeriod) =>
		onChange({
			...filter,
			period: filter.period === period ? "all" : period,
		});
	return (
		<div className="flex flex-col gap-2">
			<div className="flex gap-2">
				<label className="flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-[10px] border border-line bg-surface px-2.5 text-text-2 focus-within:outline-2 focus-within:outline-accent">
					<SearchIcon />
					<input
						type="search"
						aria-label="キーワード"
						placeholder="キーワード"
						value={q}
						onChange={(e) => setQ(e.target.value)}
						className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none"
					/>
				</label>
				<Button size="sm" onClick={() => setOpen(true)}>
					<FilterIcon />
					絞り込み
					{count > 0 && (
						<span className="num rounded-full bg-accent px-1.5 text-[11px] text-white dark:text-accent-ink">
							{count}
						</span>
					)}
				</Button>
			</div>
			<fieldset className="-mx-4 flex min-w-0 gap-1.5 overflow-x-auto px-4 lg:mx-0 lg:px-0">
				<legend className="sr-only">よく使う条件</legend>
				<Chip
					pressed={filter.active}
					onClick={() => onChange({ ...filter, active: !filter.active })}
				>
					{ACTIVE_LABEL}
				</Chip>
				{filter.period === "custom" && (
					<Chip pressed onClick={() => setPeriod("custom")}>
						{customRangeLabel(filter)}
					</Chip>
				)}
				{(["24h", "7d"] as const).map((p) => (
					<Chip
						key={p}
						pressed={filter.period === p}
						onClick={() => setPeriod(p)}
					>
						{PERIOD_LABELS[p]}
					</Chip>
				))}
				{IMPACTS.map((i) => (
					<Chip
						key={i}
						pressed={filter.impacts.includes(i)}
						onClick={() =>
							onChange({ ...filter, impacts: toggle(filter.impacts, i) })
						}
					>
						{IMPACT_LABELS[i]}
					</Chip>
				))}
			</fieldset>
			{open && (
				<FilterModal
					initial={filter}
					onApply={(f) => {
						onChange({ ...f, q: filter.q });
						setOpen(false);
					}}
					onClose={() => setOpen(false)}
				/>
			)}
		</div>
	);
}

function Chip({
	pressed,
	onClick,
	children,
}: {
	pressed: boolean;
	onClick: () => void;
	children: string;
}) {
	return (
		<button
			type="button"
			aria-pressed={pressed}
			onClick={onClick}
			className={`h-8 shrink-0 rounded-full border px-3 text-xs font-semibold whitespace-nowrap ${pressed ? "border-accent bg-accent text-white dark:text-accent-ink" : "border-line bg-surface text-text-2"}`}
		>
			{children}
		</button>
	);
}

function FilterModal({
	initial,
	onApply,
	onClose,
}: {
	initial: NewsFilterState;
	onApply: (f: NewsFilterState) => void;
	onClose: () => void;
}) {
	const ids = { from: useId(), to: useId() };
	const [f, setF] = useState(initial);
	const rangeError = customRangeError(f);
	const dateClass =
		"num h-11 min-w-0 rounded-[10px] border border-line bg-surface px-2 text-sm";
	return (
		<Modal title="絞り込み" onClose={onClose}>
			<section className="flex flex-col gap-2">
				<h3 className="text-[13px] font-bold">期間（公開時刻）</h3>
				<Segmented
					name="news-period"
					label="期間"
					size="sm"
					options={NEWS_PERIODS.map((p) => [p, PERIOD_LABELS[p]] as const)}
					value={f.period}
					onChange={(period) => setF({ ...f, period })}
				/>
				{f.period === "custom" && (
					<>
						<div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
							<label htmlFor={ids.from} className="flex flex-col gap-1 text-xs">
								開始日
								<input
									id={ids.from}
									type="date"
									value={f.fromDate}
									onChange={(e) => setF({ ...f, fromDate: e.target.value })}
									className={dateClass}
								/>
							</label>
							<span className="pb-3 text-text-2">〜</span>
							<label htmlFor={ids.to} className="flex flex-col gap-1 text-xs">
								終了日
								<input
									id={ids.to}
									type="date"
									value={f.toDate}
									onChange={(e) => setF({ ...f, toDate: e.target.value })}
									className={dateClass}
								/>
							</label>
						</div>
						{rangeError && (
							<p role="alert" className="text-xs font-semibold text-loss">
								{rangeError}
							</p>
						)}
					</>
				)}
			</section>
			<section className="flex flex-col gap-2">
				<h3 className="text-[13px] font-bold">
					影響の大きさ（どれかに当てはまる）
				</h3>
				<div className="flex flex-wrap gap-1.5">
					{IMPACTS.map((i) => (
						<Chip
							key={i}
							pressed={f.impacts.includes(i)}
							onClick={() => setF({ ...f, impacts: toggle(f.impacts, i) })}
						>
							{IMPACT_LABELS[i]}
						</Chip>
					))}
				</div>
			</section>
			<section className="flex flex-col gap-2">
				<h3 className="text-[13px] font-bold">持続（どれかに当てはまる）</h3>
				<div className="flex flex-wrap gap-1.5">
					{DURATIONS.map((d) => (
						<Chip
							key={d}
							pressed={f.durations.includes(d)}
							onClick={() => setF({ ...f, durations: toggle(f.durations, d) })}
						>
							{DURATION_LABELS[d]}
						</Chip>
					))}
				</div>
			</section>
			<section className="flex flex-col gap-2">
				<h3 className="text-[13px] font-bold">市場評価</h3>
				<div className="flex flex-wrap gap-1.5">
					<Chip
						pressed={f.active}
						onClick={() => setF({ ...f, active: !f.active })}
					>
						{ACTIVE_LABEL}
					</Chip>
				</div>
				<p className="text-xs text-text-2">
					上の市場評価に使っている（重みが 0% より大きい）ニュースだけ
				</p>
			</section>
			<section className="flex flex-col gap-2">
				<h3 className="text-[13px] font-bold">並び順</h3>
				<Segmented
					name="news-sort"
					label="並び順"
					size="sm"
					options={(["new", "impact"] as const).map(
						(s) => [s, SORT_LABELS[s]] as const,
					)}
					value={f.sort}
					onChange={(sort) => setF({ ...f, sort })}
				/>
			</section>
			<div className="flex items-center justify-between gap-2">
				<Button
					variant="link"
					onClick={() => setF({ ...EMPTY_FILTER, q: f.q })}
				>
					条件をクリア
				</Button>
				<Button
					variant="primary"
					size="sm"
					disabled={rangeError !== null}
					onClick={() => onApply(f)}
				>
					この条件で見る
				</Button>
			</div>
		</Modal>
	);
}
