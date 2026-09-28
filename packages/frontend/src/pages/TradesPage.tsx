// 取引画面。ペーパーとライブをタブで切り替え、そのモードの成績と、自動取引の注文・約定・取消を絞り込んで日ごとにまとめて出す

import type { StoredOrder, TradingMode } from "@trading-studio/backend";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { OrderRow, orderTime } from "../components/backtest/OrderViews";
import { Page } from "../components/Page";
import { EmptyState, ErrorState, LoadingCard } from "../components/States";
import { PerformanceCard } from "../components/trading/PerformanceCard";
import {
	LIVE_AVAILABLE,
	MODE_LABELS,
	TradeOrderSheet,
} from "../components/trading/TradeViews";
import { Button, Card, Tabs } from "../components/ui";
import { formatDate, formatDateWeekday } from "../format";
import { formatSignedInt } from "../lib/number";
import {
	useTradingOrders,
	useTradingPerformance,
	useTradingStatus,
} from "../lib/trading";
import { usePageVisible } from "../lib/useAsync";

type KindFilter = "all" | StoredOrder["status"];
type SideFilter = "all" | StoredOrder["side"];

const MODE_TABS: readonly (readonly [TradingMode, string])[] = [
	["paper", MODE_LABELS.paper],
	["live", MODE_LABELS.live],
];
const isMode = (v: string | null): v is TradingMode =>
	v === "paper" || v === "live";
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

/** タブはクエリの mode で持つ。無ければ運用中のモード（ホームで選んでいるモード）で開く */
export function TradesPage() {
	const [params, setParams] = useSearchParams();
	const param = params.get("mode");
	const { status } = useTradingStatus();
	const mode: TradingMode | null = isMode(param)
		? param
		: (status?.mode ?? null);
	return (
		<Page title="取引">
			{mode === null ? (
				<LoadingCard />
			) : (
				<>
					<Tabs
						label="モード"
						items={MODE_TABS}
						current={mode}
						onSelect={(m) => setParams({ mode: m }, { replace: true })}
					/>
					{mode === "live" && !LIVE_AVAILABLE ? (
						<Card>
							<EmptyState
								title="ライブ取引はまだ使えない"
								description="使えるようになると、ライブの成績と注文・約定がここに並ぶ"
							/>
						</Card>
					) : (
						// モードを切り替えたら絞り込みと選んだ注文を戻す
						<ModeTrades key={mode} mode={mode} />
					)}
				</>
			)}
		</Page>
	);
}

function ModeTrades({ mode }: { mode: TradingMode }) {
	const visible = usePageVisible();
	const [kind, setKind] = useState<KindFilter>("all");
	const [side, setSide] = useState<SideFilter>("all");
	const [selected, setSelected] = useState<string | null>(null);
	const { orders, summary, error, reload } = useTradingOrders(
		{
			mode,
			...(kind !== "all" && { status: kind }),
			...(side !== "all" && { side }),
		},
		visible,
	);
	const performance = useTradingPerformance(mode, visible);

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

	return (
		<>
			<PerformanceCard
				title={`${MODE_LABELS[mode]}の成績`}
				performance={performance.performance}
				error={performance.error}
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
						{summary?.count ?? orders.length} 件 · 実現損益{" "}
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
									title={`${MODE_LABELS[mode]}の取引はまだない`}
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
											key={o.id}
											order={o}
											selected={selected === o.id}
											onClick={() => setSelected(o.id)}
										/>
									))}
								</div>
							</section>
						))
					)}
					{summary && summary.count > orders.length && (
						<p className="text-xs text-text-2">
							一覧は新しい順に {orders.length}{" "}
							件まで出している。件数と実現損益はすべてを数えている
						</p>
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
					mode={mode}
					id={selected}
					initial={orders?.find((o) => o.id === selected) ?? null}
					onSelect={setSelected}
					onClose={() => setSelected(null)}
				/>
			)}
		</>
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
