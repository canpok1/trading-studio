// ホームの「稼働中の戦略」。オンの戦略と、オフでも保有がある戦略をカードで並べ、選んだ値で比べる。
// カードを押すとチャートの印をその戦略に切り替える

import type {
	AutoTradingStatus,
	StrategySummary,
} from "@trading-studio/backend";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Skeleton } from "../../../shared/components/States";
import { useApi } from "../../../shared/lib/api";
import { distanceText } from "../../../shared/lib/strategy-watch";
import {
	readJson,
	useInterval,
	usePageVisible,
} from "../../../shared/lib/useAsync";
import type { CompareKey } from "../utils/compare";
import {
	barOf,
	COMPARE_KEYS,
	COMPARE_LABELS,
	compared,
	isCompareKey,
	SIGNED,
} from "../utils/compare";
import { KindBadge } from "./StrategyWatch";

/** 要約を読み直す間隔（自動取引の状態と同じ） */
const SUMMARY_MS = 5_000;
const MARK_KEY = "home-mark";
const COMPARE_KEY = "home-compare";

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
	const shownIds = new Set(summaries?.map((s) => s.status.id));
	const stopped =
		runs && summaries ? runs.filter((r) => !shownIds.has(r.id)).length : 0;
	const values = summaries?.map((s) => compared(s, key)) ?? [];
	// 勝率は 0〜100% の中で比べる。他は並べたカードの一番大きい値を目いっぱいにする
	const scale = key === "winRate" ? [100] : values.map((v) => v.amount);

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
				<label className="ml-auto flex items-center gap-2 text-xs text-text-2">
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
					<div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4 xl:grid-cols-5">
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
				<ul className="grid grid-cols-2 gap-2.5 lg:grid-cols-4 xl:grid-cols-5">
					{summaries.map((s, i) => (
						<StrategyCard
							key={s.status.id}
							summary={s}
							value={values[i] ?? compared(s, key)}
							bar={barOf(values[i]?.amount ?? null, scale, SIGNED[key])}
							selected={s.status.id === markId}
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
	bar,
	selected,
	onSelect,
}: {
	summary: StrategySummary;
	value: ReturnType<typeof compared>;
	bar: { left: number; width: number } | null;
	selected: boolean;
	onSelect: () => void;
}) {
	const { status } = s;
	const moves = s.nextMoves;
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
				className="flex min-w-0 flex-1 flex-col gap-1 rounded-xl px-3 pt-2.5 pb-2 text-left hover:bg-surface-2"
			>
				<span className="flex min-w-0 items-center gap-1.5">
					<span
						aria-hidden
						className={`size-2 shrink-0 rounded-full ${status.enabled ? "bg-profit" : "bg-text-2"}`}
					/>
					<b className="min-w-0 flex-1 truncate text-[13px]">{status.name}</b>
					{selected && (
						<span className="shrink-0 rounded bg-accent px-1.5 py-px text-[10px] font-semibold text-white dark:text-accent-ink">
							チャート
						</span>
					)}
				</span>
				{!status.enabled && (
					<span className="text-[11px] text-text-2">
						停止中（保有・注文あり）
					</span>
				)}
				<span
					data-testid="home-strategy-value"
					className={`num text-xl font-semibold tracking-tight ${
						value.tone === "profit"
							? "text-profit"
							: value.tone === "loss"
								? "text-loss"
								: ""
					}`}
				>
					{value.text}
				</span>
				<span className="num text-xs text-text-2">{value.sub}</span>
				<span
					aria-hidden
					className="relative my-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
				>
					{bar && (
						<span
							className={`absolute inset-y-0 ${value.tone === "loss" ? "bg-loss" : "bg-profit"}`}
							style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
						/>
					)}
				</span>
				{moves && (
					<span className="flex flex-col gap-1 text-xs">
						{moves.now.map((a) => (
							<span
								key={`now-${a.kind}-${a.buyId}-${a.lotId ?? ""}`}
								className="flex flex-wrap items-center gap-1"
							>
								<span className="font-semibold">● 次の判定で</span>
								<KindBadge action={a} multi={moves.multiBuy} />
							</span>
						))}
						<MoveLine
							arrow="↑"
							action={moves.up}
							from={moves.price}
							multi={moves.multiBuy}
						/>
						<MoveLine
							arrow="↓"
							action={moves.down}
							from={moves.price}
							multi={moves.multiBuy}
						/>
					</span>
				)}
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

/** 「↑ +0.88%で 利確」。円の差はカードでは省き、戦略の画面で出す */
function MoveLine({
	arrow,
	action,
	from,
	multi,
}: {
	arrow: "↑" | "↓";
	action: NonNullable<StrategySummary["nextMoves"]>["up"];
	from: number;
	multi: boolean;
}) {
	return (
		<span className="flex flex-wrap items-center gap-1">
			<span
				aria-hidden
				className={`font-bold ${arrow === "↑" ? "text-profit" : "text-loss"}`}
			>
				{arrow}
			</span>
			{action && action.price !== null ? (
				<>
					<span className="num">{distanceText(action.price, from)}で</span>
					<KindBadge action={action} multi={multi} />
				</>
			) : (
				<span className="text-text-2">—</span>
			)}
		</span>
	);
}
