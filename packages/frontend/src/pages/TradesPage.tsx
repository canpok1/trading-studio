// 取引画面。自動取引の注文・約定・取消を絞り込み、日ごとにまとめて出す

import type { StoredOrder, TradingMode } from "@trading-studio/backend";
import { useMemo, useState } from "react";
import { OrderRow, orderTime } from "../components/backtest/OrderViews";
import { Page } from "../components/Page";
import { EmptyState, ErrorState, LoadingCard } from "../components/States";
import { ModeTag, TradeOrderSheet } from "../components/trading/TradeViews";
import { Button, Card, Segmented } from "../components/ui";
import { formatDate, formatDateWeekday } from "../format";
import { formatSignedInt } from "../lib/number";
import { useTradingOrders } from "../lib/trading";
import { usePageVisible } from "../lib/useAsync";

type ModeFilter = "all" | TradingMode;
type KindFilter = "all" | StoredOrder["status"];
type SideFilter = "all" | StoredOrder["side"];

const MODE_OPTIONS = [
	["all", "すべて"],
	["paper", "ペーパー"],
	["live", "ライブ"],
] as const;
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

export function TradesPage() {
	const visible = usePageVisible();
	const [mode, setMode] = useState<ModeFilter>("all");
	const [kind, setKind] = useState<KindFilter>("all");
	const [side, setSide] = useState<SideFilter>("all");
	const [selected, setSelected] = useState<{
		mode: TradingMode;
		id: string;
	} | null>(null);
	const { orders, error, reload } = useTradingOrders(
		{
			...(mode !== "all" && { mode }),
			...(kind !== "all" && { status: kind }),
			...(side !== "all" && { side }),
		},
		visible,
	);

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
	const realized = (orders ?? []).reduce((a, o) => a + (o.pnl ?? 0), 0);
	const filtered = mode !== "all" || kind !== "all" || side !== "all";

	return (
		<Page title="取引">
			<Segmented
				name="trades-mode"
				label="モード"
				options={MODE_OPTIONS}
				value={mode}
				onChange={setMode}
			/>
			<div className="flex flex-wrap items-center gap-1.5">
				<FilterChips
					label="状態"
					options={KIND_OPTIONS}
					value={kind}
					onChange={setKind}
				/>
				<span className="w-2" />
				<FilterChips
					label="売買"
					options={SIDE_OPTIONS}
					value={side}
					onChange={setSide}
				/>
			</div>
			{orders === null ? (
				error ? (
					<Card>
						<ErrorState
							what="取引を読み込めなかった"
							next={error}
							action={<Button onClick={reload}>もう一度読み込む</Button>}
						/>
					</Card>
				) : (
					<LoadingCard />
				)
			) : (
				<>
					<p data-testid="trades-summary" className="num text-xs text-text-2">
						{orders.length} 件 · 実現損益{" "}
						<span
							className={`font-semibold ${realized >= 0 ? "text-profit" : "text-loss"}`}
						>
							{formatSignedInt(realized)}円
						</span>
					</p>
					{groups.length === 0 ? (
						<Card>
							{filtered ? (
								<EmptyState
									title="条件に合う取引はない"
									action={
										<Button
											onClick={() => {
												setMode("all");
												setKind("all");
												setSide("all");
											}}
										>
											絞り込みを解除
										</Button>
									}
								/>
							) : (
								<EmptyState
									title="取引はまだない"
									description="ホームで自動取引をオンにすると、注文と約定がここに並ぶ"
								/>
							)}
						</Card>
					) : (
						groups.map((g) => (
							<section
								key={g.time}
								aria-label={formatDate(g.time)}
								className="flex flex-col gap-1.5"
							>
								<h2 className="num text-xs font-semibold text-text-2">
									{formatDateWeekday(g.time)}
								</h2>
								<div className="overflow-hidden rounded-xl border border-line">
									{g.orders.map((o) => (
										<OrderRow
											key={`${o.mode}:${o.id}`}
											order={o}
											selected={
												selected?.mode === o.mode && selected.id === o.id
											}
											onClick={() => setSelected({ mode: o.mode, id: o.id })}
											tag={<ModeTag mode={o.mode} />}
										/>
									))}
								</div>
							</section>
						))
					)}
					{error && (
						<p role="alert" className="text-xs font-semibold text-loss">
							読み直せなかった（{error}）。5秒ごとに読み直している
						</p>
					)}
				</>
			)}
			{selected && (
				<TradeOrderSheet
					mode={selected.mode}
					id={selected.id}
					initial={
						orders?.find(
							(o) => o.mode === selected.mode && o.id === selected.id,
						) ?? null
					}
					onSelect={(id) => setSelected({ mode: selected.mode, id })}
					onClose={() => setSelected(null)}
				/>
			)}
		</Page>
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
