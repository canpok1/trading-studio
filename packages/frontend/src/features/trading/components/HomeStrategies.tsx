// ホームの「稼働中の戦略」。オンの戦略と、オフでも保有がある戦略をカードで並べ、選んだ値で比べる。
// カードを押すとチャートの印をその戦略に切り替える

import type {
	AutoTradingStatus,
	StrategySummary,
} from "@trading-studio/backend";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { GridIcon, ListIcon } from "../../../shared/components/icons";
import { Skeleton } from "../../../shared/components/States";
import { useApi } from "../../../shared/lib/api";
import { STOPPED_TEXT } from "../../../shared/lib/strategy-watch";
import {
	readJson,
	useInterval,
	usePageVisible,
} from "../../../shared/lib/useAsync";
import type { CompareKey } from "../utils/compare";
import {
	COMPARE_KEYS,
	COMPARE_LABELS,
	compared,
	isCompareKey,
} from "../utils/compare";
import { MoveRow } from "./StrategyWatch";

/** 要約を読み直す間隔（自動取引の状態と同じ） */
const SUMMARY_MS = 5_000;
const MARK_KEY = "home-mark";
const COMPARE_KEY = "home-compare";
const LAYOUT_KEY = "home-layout";

/** ホームに出す戦略の要約を読み、5秒ごとに読み直す。読めなければ前の値を残す */
export function useStrategySummaries() {
	const api = useApi();
	const visible = usePageVisible();
	const [summaries, setSummaries] = useState<StrategySummary[] | null>(null);
	const [error, setError] = useState(false);
	const seq = useRef(0);
	const load = useCallback(async () => {
		const my = ++seq.current;
		try {
			const r = await api.api.trading.summaries
				.$get()
				.then((res) => readJson<{ summaries: StrategySummary[] }>(res));
			if (my === seq.current) {
				setSummaries(r.summaries);
				setError(false);
			}
		} catch {
			if (my === seq.current) setError(true);
		}
	}, [api]);
	useEffect(() => {
		if (visible) load();
	}, [visible, load]);
	useInterval(load, SUMMARY_MS, visible);
	return { summaries, error };
}

function readStored(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStored(key: string, value: string) {
	try {
		localStorage.setItem(key, value);
	} catch {
		// 保存できなくても、この画面の間は切り替わる
	}
}

/** 印の対象に選んだ戦略の id。ブラウザに保存する */
export function useMarkTarget(): [number | null, (id: number) => void] {
	const [id, setId] = useState<number | null>(() => {
		const v = Number(readStored(MARK_KEY));
		return Number.isInteger(v) && v > 0 ? v : null;
	});
	const change = (next: number) => {
		setId(next);
		writeStored(MARK_KEY, String(next));
	};
	return [id, change];
}

/** 選んだ印の対象がホームに無ければ（止めた・消した）、先頭の戦略にする */
export function markTargetOf(
	summaries: readonly StrategySummary[],
	chosen: number | null,
): StrategySummary | null {
	return summaries.find((s) => s.status.id === chosen) ?? summaries[0] ?? null;
}

function useCompareKey(): [CompareKey, (k: CompareKey) => void] {
	const [key, setKey] = useState<CompareKey>(() => {
		const v = readStored(COMPARE_KEY);
		return isCompareKey(v) ? v : "pnl";
	});
	const change = (k: CompareKey) => {
		setKey(k);
		writeStored(COMPARE_KEY, k);
	};
	return [key, change];
}

/** スマホ幅の並べ方。2列は押しやすさ、1列は名前を全部出して見分けやすさを優先する。PC 幅は常に横一列 */
type Layout = "grid" | "list";

function useLayout(): [Layout, (l: Layout) => void] {
	const [layout, setLayout] = useState<Layout>(() =>
		readStored(LAYOUT_KEY) === "list" ? "list" : "grid",
	);
	const change = (l: Layout) => {
		setLayout(l);
		writeStored(LAYOUT_KEY, l);
	};
	return [layout, change];
}

export function HomeStrategies({
	summaries,
	error,
	runs,
	markId,
	onMark,
}: {
	summaries: StrategySummary[] | null;
	error: boolean;
	runs: AutoTradingStatus[] | null;
	markId: number | null;
	onMark: (id: number) => void;
}) {
	const [key, setKey] = useCompareKey();
	const [layout, setLayout] = useLayout();
	const list = layout === "list";
	const shownIds = new Set(summaries?.map((s) => s.status.id));
	const stopped =
		runs && summaries ? runs.filter((r) => !shownIds.has(r.id)).length : 0;

	return (
		<section
			aria-label="稼働中の戦略"
			className="flex flex-col gap-2.5 lg:col-span-2"
		>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
				<h2 className="text-[15px] font-bold">稼働中の戦略</h2>
				<span className="hidden text-xs text-text-2 sm:inline">
					押すとチャートの印を切り替え
				</span>
				<fieldset
					aria-label="並べ方"
					className="ml-auto flex h-9 overflow-hidden rounded-lg border border-line lg:hidden"
				>
					<LayoutButton
						label="2列"
						pressed={!list}
						onClick={() => setLayout("grid")}
					>
						<GridIcon />
					</LayoutButton>
					<LayoutButton
						label="1列"
						pressed={list}
						onClick={() => setLayout("list")}
					>
						<ListIcon />
					</LayoutButton>
				</fieldset>
				<label className="flex items-center gap-2 text-xs text-text-2 lg:ml-auto">
					<span className="hidden sm:inline">比べる値</span>
					<select
						aria-label="比べる値"
						value={key}
						onChange={(e) => setKey(e.target.value as CompareKey)}
						className="h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] font-semibold text-text"
					>
						{COMPARE_KEYS.map((k) => (
							<option key={k} value={k}>
								{COMPARE_LABELS[k]}
							</option>
						))}
					</select>
				</label>
			</div>
			{summaries === null ? (
				error ? (
					<p role="alert" className="text-xs font-semibold text-loss">
						戦略の要約を読み込めなかった。5秒ごとに読み直している
					</p>
				) : (
					<div
						className={`grid gap-2.5 lg:grid-cols-4 xl:grid-cols-5 ${list ? "grid-cols-1" : "grid-cols-2"}`}
					>
						<Skeleton className="h-36" />
						<Skeleton className="h-36" />
					</div>
				)
			) : summaries.length === 0 ? (
				<div className="flex items-center gap-3 rounded-xl bg-surface p-3.5 text-[13px]">
					<span className="flex-1">
						{runs?.length === 0
							? "戦略がまだ無い。戦略を作って自動取引をオンにすると、ここで比べられる"
							: "稼働中の戦略は無い。戦略の画面で自動取引をオンにすると、ここで比べられる"}
					</span>
					<Link
						to="/strategies"
						className="shrink-0 font-semibold text-accent underline"
					>
						{runs?.length === 0 ? "戦略を作る" : "戦略を見る"}
					</Link>
				</div>
			) : (
				<ul
					className={`grid gap-2.5 lg:grid-cols-4 xl:grid-cols-5 ${list ? "grid-cols-1" : "grid-cols-2"}`}
				>
					{summaries.map((s) => (
						<StrategyCard
							key={s.status.id}
							summary={s}
							value={compared(s, key)}
							selected={s.status.id === markId}
							list={list}
							onSelect={() => onMark(s.status.id)}
						/>
					))}
				</ul>
			)}
			{stopped > 0 && (
				<Link to="/strategies" className="text-[13px] text-text-2 underline">
					停止中 {stopped} 件は「戦略」で見られる ›
				</Link>
			)}
		</section>
	);
}

function StrategyCard({
	summary: s,
	value,
	selected,
	list,
	onSelect,
}: {
	summary: StrategySummary;
	value: ReturnType<typeof compared>;
	selected: boolean;
	/** スマホ幅の1列。名前を1行目の全幅に置いて切らずに出し、その下に次の動き（左）と値・補足（右）を並べる */
	list: boolean;
	onSelect: () => void;
}) {
	const { status } = s;
	// 1列では格子で置き場所を決める。PC 幅は2列と同じ縦積みに戻す（格子の置き場所は効かない）
	const at = (cls: string) => (list ? cls : "");
	return (
		<li
			data-testid="home-strategy"
			className={`flex min-w-0 flex-col rounded-xl bg-surface ${
				selected ? "border-2 border-accent" : "border border-line"
			}`}
		>
			<button
				type="button"
				aria-pressed={selected}
				onClick={onSelect}
				className={`min-w-0 flex-1 rounded-xl px-3 pt-2.5 pb-2 text-left hover:bg-surface-2 ${
					list
						? "grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-1.5 gap-y-1 lg:flex lg:flex-col lg:items-stretch lg:gap-1"
						: "flex flex-col gap-1"
				}`}
			>
				<span
					className={`flex min-w-0 items-center gap-1.5 ${at("col-span-3 row-start-1")}`}
				>
					<span
						aria-hidden
						className={`size-2 shrink-0 rounded-full ${status.enabled ? "bg-profit" : "bg-text-2"}`}
					/>
					<b
						className={`min-w-0 flex-1 text-[13px] ${list ? "break-words lg:truncate" : "truncate"}`}
					>
						{status.name}
					</b>
					{selected && (
						<span className="shrink-0 rounded bg-accent px-1.5 py-px text-[10px] font-semibold text-white dark:text-accent-ink">
							チャート
						</span>
					)}
				</span>
				{!status.enabled && (
					<span
						className={`text-[11px] text-text-2 ${at("col-start-1 row-start-2")}`}
					>
						停止中（保有・注文あり）
					</span>
				)}
				<span
					data-testid="home-strategy-value"
					className={`num text-xl font-semibold tracking-tight ${at("col-start-2 row-start-2")} ${
						value.tone === "profit"
							? "text-profit"
							: value.tone === "loss"
								? "text-loss"
								: ""
					}`}
				>
					{value.text}
				</span>
				<span
					className={`num text-xs text-text-2 ${at("col-start-3 row-start-2")}`}
				>
					{value.sub}
				</span>
				<CardMoves
					summary={s}
					className={at(
						`col-start-1 ${status.enabled ? "row-start-2" : "row-start-3"}`,
					)}
				/>
			</button>
			{selected && (
				<Link
					to={`/strategies/${status.id}`}
					className="self-end px-3 pb-2.5 text-xs font-semibold text-accent underline"
				>
					詳しく ›
				</Link>
			)}
		</li>
	);
}

/** カードに出す次の動きの数。全部は戦略の画面で見る */
const CARD_MOVES = 2;

/** カードの次の動き。優先度の高い上位だけ出す。オフは判定しないので、出している注文だけ出す */
function CardMoves({
	summary: s,
	className,
}: {
	summary: StrategySummary;
	className: string;
}) {
	const n = s.nextMoves;
	if (!n) {
		return (
			<span className={`text-xs text-text-2 ${className}`}>
				{s.status.enabled ? "価格が取れず試算できない" : STOPPED_TEXT}
			</span>
		);
	}
	const moves = (
		s.status.enabled
			? n.moves
			: n.moves.filter((m) => m.trigger.kind === "order")
	).slice(0, CARD_MOVES);
	return (
		<span className={`flex flex-col gap-1 text-xs ${className}`}>
			{!s.status.enabled && <span className="text-text-2">{STOPPED_TEXT}</span>}
			{moves.map((m) => (
				<MoveRow
					key={`${m.buyId}:${m.kind}`}
					move={m}
					price={n.price}
					multi={n.multiBuy}
					detailed={false}
				/>
			))}
			{s.status.enabled && moves.length === 0 && (
				<span className="text-text-2">次の動きなし</span>
			)}
		</span>
	);
}

function LayoutButton({
	label,
	pressed,
	onClick,
	children,
}: {
	label: string;
	pressed: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			aria-pressed={pressed}
			onClick={onClick}
			className={`grid w-9 place-items-center ${
				pressed
					? "bg-accent text-white dark:text-accent-ink"
					: "bg-surface text-text-2"
			}`}
		>
			{children}
		</button>
	);
}
