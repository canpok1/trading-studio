// ホームの注文・約定。状態と売買で絞り込み、日ごとにまとめて10件ずつ出す

import type { StoredOrder } from "@trading-studio/backend";
import { useMemo, useState } from "react";
import { formatDate, formatDateWeekday } from "../../format";
import { formatSignedInt } from "../../lib/number";
import { useTradingOrders } from "../../lib/trading";
import { OrderRow, orderTime } from "../backtest/OrderViews";
import { EmptyState, ErrorState, Skeleton } from "../States";
import { Button } from "../ui";
import { PANEL, PanelHeader } from "./Panel";

type KindFilter = "all" | StoredOrder["status"];
type SideFilter = "all" | StoredOrder["side"];

/** 最初に出す件数と、「さらに表示」で足す件数 */
export const ORDERS_PAGE = 10;
/** 一覧に出せる最大の件数（API の上限） */
const MAX_ORDERS = 1_000;

const KIND_OPTIONS: readonly (readonly [KindFilter, string])[] = [
	["all", "すべて"],
	["filled", "約定"],
	["open", "注文中"],
	["canceled", "取消"],
];
const SIDE_OPTIONS: readonly (readonly [SideFilter, string])[] = [
	["all", "売買すべて"],
	["buy", "買"],
	["sell", "売"],
];

/** 選んだ注文の詳細は、チャートの印と共通なのでホームが出す */
export function OrdersPanel({
	runId,
	active,
	selectedId,
	onSelect,
}: {
	runId: number;
	active: boolean;
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	const [kind, setKind] = useState<KindFilter>("all");
	const [side, setSide] = useState<SideFilter>("all");
	const [limit, setLimit] = useState(ORDERS_PAGE);
	const loaded = useTradingOrders(
		{
			runId,
			...(kind !== "all" && { status: kind }),
			...(side !== "all" && { side }),
			limit,
		},
		active,
	);
	// 「さらに表示」で件数を変えても、届くまでは今の一覧を出したままにする（一覧が縮んで位置がずれないように）
	const filterKey = `${kind}:${side}`;
	const [kept, setKept] = useState<{
		filterKey: string;
		orders: StoredOrder[];
		summary: typeof loaded.summary;
	} | null>(null);
	if (
		loaded.orders &&
		(kept?.orders !== loaded.orders || kept.filterKey !== filterKey)
	) {
		setKept({ filterKey, orders: loaded.orders, summary: loaded.summary });
	}
	const fallback = kept?.filterKey === filterKey ? kept : null;
	const orders = loaded.orders ?? fallback?.orders ?? null;
	const summary = loaded.orders ? loaded.summary : (fallback?.summary ?? null);
	const { error, reload } = loaded;
	const groups = useMemo(() => {
		const map = new Map<string, { time: number; orders: StoredOrder[] }>();
		for (const o of orders ?? []) {
			const t = orderTime(o);
			const key = formatDate(t);
			const g = map.get(key);
			if (g) g.orders.push(o);
			else map.set(key, { time: t, orders: [o] });
		}
		return [...map.values()];
	}, [orders]);
	const realized = summary?.realizedPnl ?? 0;
	const filtered = kind !== "all" || side !== "all";
	// 絞り込みを変えたら最初の10件に戻す
	const filter =
		<T,>(set: (v: T) => void) =>
		(v: T) => {
			set(v);
			setLimit(ORDERS_PAGE);
		};

	return (
		<section aria-label="注文・約定" className={`${PANEL} lg:col-span-2`}>
			<PanelHeader title="注文・約定" />
			<div className="flex flex-wrap items-center gap-1.5">
				<FilterChips
					label="状態"
					options={KIND_OPTIONS}
					value={kind}
					onChange={filter(setKind)}
				/>
				<span className="w-2" />
				<FilterChips
					label="売買"
					options={SIDE_OPTIONS}
					value={side}
					onChange={filter(setSide)}
				/>
			</div>
			{orders === null ? (
				error ? (
					<ErrorState
						what="注文を読み込めなかった"
						next={error}
						action={<Button onClick={reload}>もう一度読み込む</Button>}
					/>
				) : (
					<Skeleton className="h-10" />
				)
			) : (
				<>
					<p data-testid="trades-summary" className="num text-xs text-text-2">
						{summary?.count ?? orders.length} 件 · 実現損益{" "}
						<span
							className={`font-semibold ${realized >= 0 ? "text-profit" : "text-loss"}`}
						>
							{formatSignedInt(realized)}円
						</span>
					</p>
					{groups.length === 0 ? (
						filtered ? (
							<EmptyState
								title="条件に合う注文は無い"
								action={
									<Button
										onClick={() => {
											setKind("all");
											setSide("all");
											setLimit(ORDERS_PAGE);
										}}
									>
										絞り込みを解除
									</Button>
								}
							/>
						) : (
							<p className="rounded-xl border border-line px-4 py-6 text-center text-sm text-text-2">
								このタブの注文はまだ無い
							</p>
						)
					) : (
						groups.map((g) => (
							<div key={g.time} className="flex flex-col gap-1.5">
								<h3 className="num text-xs font-semibold text-text-2">
									{formatDateWeekday(g.time)}
								</h3>
								<div className="overflow-hidden rounded-xl border border-line">
									{g.orders.map((o) => (
										<OrderRow
											key={o.id}
											order={o}
											selected={o.id === selectedId}
											onClick={() => onSelect(o.id)}
										/>
									))}
								</div>
							</div>
						))
					)}
					{summary &&
						summary.count > orders.length &&
						(orders.length < MAX_ORDERS ? (
							<Button
								onClick={() =>
									setLimit((n) => Math.min(n + ORDERS_PAGE, MAX_ORDERS))
								}
							>
								さらに表示
							</Button>
						) : (
							<p className="text-xs text-text-2">
								一覧は新しい順に {MAX_ORDERS}{" "}
								件まで出している。件数と実現損益はすべてを数えている
							</p>
						))}
					{error && (
						<p role="alert" className="text-xs font-semibold text-loss">
							読み直せなかった（{error}）。5秒ごとに読み直している
						</p>
					)}
				</>
			)}
		</section>
	);
}

function FilterChips<T extends string>({
	label,
	options,
	value,
	onChange,
}: {
	label: string;
	options: readonly (readonly [T, string])[];
	value: T;
	onChange: (v: T) => void;
}) {
	return (
		<fieldset className="contents">
			<legend className="sr-only">{label}</legend>
			{options.map(([v, text]) => (
				<button
					key={v}
					type="button"
					aria-pressed={value === v}
					onClick={() => onChange(v)}
					className="h-[34px] rounded-full border border-line px-3 text-[13px] text-text-2 aria-pressed:border-[1.5px] aria-pressed:border-text aria-pressed:bg-surface aria-pressed:font-bold aria-pressed:text-text"
				>
					{text}
				</button>
			))}
		</fieldset>
	);
}
