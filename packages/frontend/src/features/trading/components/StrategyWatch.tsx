// ホームの「次の動き」（チャートの上）と「戦略の見張り」（チャートの下）。
// 戦略を今の価格で試算し、価格がいくらになれば何が起きるかと、条件ごとの今の値を出す

import type {
	StrategyWatch,
	WatchAction,
	WatchActionKind,
	WatchBuy,
	WatchCondition,
	WatchGroup,
	WatchLot,
} from "@trading-studio/core";
import { formatBtc, nextMoves } from "@trading-studio/core";
import { useCallback, useState } from "react";
import { Help } from "../../../shared/components/Help";
import { conditionText } from "../../../shared/lib/condition-text";
import { formatInt } from "../../../shared/lib/number";
import type { WaitLine } from "../../../shared/lib/strategy-watch";
import {
	ACTION_LABELS,
	buyStatusText,
	distanceText,
	metCount,
	moveText,
	pendingOrderWaits,
	STOPPED_TEXT,
	waitLines,
} from "../../../shared/lib/strategy-watch";
import { PANEL } from "./Panel";

/** 種類のバッジ。買い系は寒色、売り系は暖色（利確は明るい橙・損切りは暗い赤茶） */
const KIND_BADGE: Record<WatchActionKind, string> = {
	entry: "bg-buy/12 text-buy",
	partialTakeProfit: "bg-take-profit-bg text-take-profit",
	takeProfit: "bg-take-profit-bg text-take-profit",
	stopLoss: "bg-stop-loss-bg text-stop-loss",
};

export function KindBadge({
	action,
	multi,
}: {
	action: WatchAction;
	multi: boolean;
}) {
	return (
		<span
			className={`rounded px-1.5 py-px text-[11px] font-semibold whitespace-nowrap ${KIND_BADGE[action.kind]}`}
		>
			{ACTION_LABELS[action.kind]}
			{multi && `「${action.buyName}」`}
		</span>
	);
}

/** 価格で起きない売買の行。売り注文の約定待ちは利確・損切りのどちらでもないので無彩色にする */
export function WaitRow({
	line,
	multi,
	className = "",
}: {
	line: WaitLine;
	multi: boolean;
	className?: string;
}) {
	const badge =
		line.kind === "sell" ? "bg-surface-2 text-text-2" : KIND_BADGE[line.kind];
	return (
		<span
			className={`flex flex-wrap items-center gap-x-1.5 gap-y-0.5 ${className}`}
		>
			<span aria-hidden className="w-3.5 text-text-2">
				⏸
			</span>
			<span
				className={`rounded px-1.5 py-px text-[11px] font-semibold whitespace-nowrap ${badge}`}
			>
				{line.kind === "sell" ? "売り" : ACTION_LABELS[line.kind]}
				{multi && `「${line.buyName}」`}
			</span>
			<span className="text-text-2">{line.text}</span>
		</span>
	);
}

/** チャートの上に置く要約。次の判定で起きる売買と、上側・下側で一番近い発動価格、価格で起きない売買の理由 */
export function NextMovesCard({
	watch,
	stopped,
	className = "",
}: {
	watch: StrategyWatch;
	/** オフ。判定しないので試算を出さず、約定しうる未約定の注文だけ出す */
	stopped: boolean;
	className?: string;
}) {
	const { now, up, down, waits } = nextMoves(watch);
	const multi = watch.buys.length >= 2;
	return (
		<section aria-label="次の動き" className={`${PANEL} gap-2 ${className}`}>
			<div className="flex min-h-6 items-center gap-1.5">
				<h2 className="text-[15px] font-bold">次の動き</h2>
				<Help label="次の動き">
					<p>
						戦略を今の価格で試算し、今の価格からどれだけ動けば何をするかを出す。上側・下側で一番近いものだけ。発動する価格そのものはチャートの札と「戦略の見張り」で見る。
					</p>
					<p>
						⏸
						の行は、価格が動くだけでは起きない売買と、その理由（買いが止まっている・価格以外の条件が未成立など）。
					</p>
					<p>
						実際に注文するのは次の判定のとき。全部の条件はチャートの下の「戦略の見張り」で見る。
					</p>
				</Help>
			</div>
			{stopped ? (
				<ul className="flex flex-col gap-1.5 text-sm">
					<li className="text-text-2">{STOPPED_TEXT}</li>
					{waitLines(pendingOrderWaits(waits), watch.price).map((l) => (
						<li key={l.key}>
							<WaitRow line={l} multi={multi} />
						</li>
					))}
				</ul>
			) : (
				<ul className="flex flex-col gap-1.5 text-sm">
					{now.map((a) => (
						<li
							key={`now-${a.kind}-${a.buyId}-${a.lotId ?? ""}`}
							className="flex flex-wrap items-center gap-x-2 gap-y-0.5"
						>
							<span aria-hidden className="w-3.5 font-bold text-text-2">
								●
							</span>
							<span>次の判定で</span>
							<KindBadge action={a} multi={multi} />
						</li>
					))}
					<MoveRow arrow="↑" action={up} from={watch.price} multi={multi} />
					<MoveRow arrow="↓" action={down} from={watch.price} multi={multi} />
					{waitLines(waits, watch.price).map((l) => (
						<li key={l.key}>
							<WaitRow line={l} multi={multi} />
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function MoveRow({
	arrow,
	action,
	from,
	multi,
}: {
	arrow: "↑" | "↓";
	action: WatchAction | null;
	from: number;
	multi: boolean;
}) {
	return (
		<li className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
			<span
				aria-hidden
				className={`w-3.5 font-bold ${arrow === "↑" ? "text-profit" : "text-loss"}`}
			>
				{arrow}
			</span>
			{action && action.price !== null ? (
				<>
					<MoveText price={action.price} from={from} />
					<KindBadge action={action} multi={multi} />
				</>
			) : (
				<span className="text-text-2">{noMoveText(arrow)}</span>
			)}
		</li>
	);
}

/** その向きに発動価格が無いとき。「—」だと不具合に見えるので文で書く */
export const noMoveText = (arrow: "↑" | "↓") =>
	arrow === "↑" ? "上がっても売買なし" : "下がっても売買なし";

/** 「+0.88%（+113,254 円）で」。向きは行頭の矢印と符号で分かるので言葉にしない。発動価格そのものはチャートの札と「戦略の見張り」で見る */
function MoveText({ price, from }: { price: number; from: number }) {
	const m = moveText(price, from);
	return (
		<span className="num">
			<b>{m.percent}</b>
			<span className="text-xs text-text-2">（{m.yen}）</span>で
		</span>
	);
}

const OPEN_KEY = "watch-open";

/** 開いたグループ。最初は全部閉じ、開いたものをブラウザに覚える */
function useOpenGroups(): [Set<string>, (key: string, open: boolean) => void] {
	const [open, setOpen] = useState<Set<string>>(() => {
		try {
			const v = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]");
			return new Set(
				Array.isArray(v) ? v.filter((x) => typeof x === "string") : [],
			);
		} catch {
			return new Set();
		}
	});
	const set = useCallback((key: string, on: boolean) => {
		setOpen((prev) => {
			const next = new Set(prev);
			if (on) next.add(key);
			else next.delete(key);
			try {
				localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
			} catch {
				// 保存できない環境では、この画面を開いている間だけ効く
			}
			return next;
		});
	}, []);
	return [open, set];
}

function MetMark({ met }: { met: boolean | null }) {
	return met === null ? (
		<span className="text-text-2" title="判定できない">
			？
		</span>
	) : met ? (
		<span className="font-bold text-profit" title="成立">
			✓
		</span>
	) : (
		<span className="text-text-2" title="不成立">
			○
		</span>
	);
}

function ConditionRow({ c, price }: { c: WatchCondition; price: number }) {
	const edge = c.met === false ? c.edge : null;
	return (
		<li className="grid grid-cols-[18px_1fr] gap-x-1.5 border-t border-dashed border-grid py-1.5 text-[13px] sm:grid-cols-[18px_1fr_auto]">
			<MetMark met={c.met} />
			<span>{conditionText(c.condition)}</span>
			<span className="num col-start-2 text-xs text-text-2 sm:col-start-3 sm:text-right">
				{c.detail}
				{edge &&
					`${c.detail ? " → " : ""}${formatInt(edge.price)} 円（${distanceText(edge.price, price)}）`}
			</span>
		</li>
	);
}

const GROUP_TITLES = {
	buy: "買い",
	partialTakeProfit: "一部利確",
	takeProfit: "利確",
	stopLoss: "損切り",
} as const;

/** 閉じた行に出す要約。発動価格があれば一番近いもの、無ければ成立の数 */
function groupSummary(g: WatchGroup, price: number): string {
	if (g.met === null) return "判定できない";
	if (g.met) return "成立";
	const nearest = [...g.triggers].sort(
		(a, b) => Math.abs(a - price) - Math.abs(b - price),
	)[0];
	if (nearest !== undefined) {
		return `${formatInt(nearest)} 円（${distanceText(nearest, price)}）`;
	}
	const { met, total } = metCount(g);
	return `${met}/${total} 成立`;
}

function GroupRow({
	id,
	kind,
	group,
	price,
	open,
	onToggle,
	extra,
}: {
	id: string;
	kind: keyof typeof GROUP_TITLES;
	group: WatchGroup;
	price: number;
	open: boolean;
	onToggle: (id: string, open: boolean) => void;
	extra?: string | null;
}) {
	const badge = kind === "buy" ? "bg-buy/12 text-buy" : KIND_BADGE[kind];
	return (
		<details
			open={open}
			onToggle={(e) => {
				const now = (e.currentTarget as HTMLDetailsElement).open;
				if (now !== open) onToggle(id, now);
			}}
			className="group border-t border-line first:border-t-0"
		>
			<summary className="grid cursor-pointer list-none grid-cols-[14px_auto_1fr_auto] items-center gap-2 py-2 text-[13px] [&::-webkit-details-marker]:hidden">
				<span aria-hidden className="text-text-2 group-open:rotate-90">
					▸
				</span>
				<span
					className={`rounded px-1.5 py-px text-[11px] font-semibold ${badge}`}
				>
					{GROUP_TITLES[kind]}
				</span>
				<span className="text-xs text-text-2">
					{group.match === "all" ? "すべて満たす" : "どれか1つ"}
				</span>
				<span className="num text-right text-xs font-semibold">
					{groupSummary(group, price)}
				</span>
			</summary>
			<ul className="pb-1.5 pl-[22px]">
				{group.conditions.map((c, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: 条件は並びで決まり、入れ替えない
					<ConditionRow key={i} c={c} price={price} />
				))}
				{extra && (
					<li className="border-t border-dashed border-grid py-1.5 text-xs text-text-2">
						{extra}
					</li>
				)}
			</ul>
		</details>
	);
}

function LotBlock({
	strategyId,
	buyId,
	lot,
	price,
	open,
	onToggle,
}: {
	strategyId: number;
	buyId: string;
	lot: WatchLot;
	price: number;
	open: Set<string>;
	onToggle: (id: string, open: boolean) => void;
}) {
	const change = (price / lot.entryPrice - 1) * 100;
	const key = (g: string) => `${strategyId}:${buyId}:${lot.id}:${g}`;
	return (
		<div className="mt-1 border-t border-line pt-1.5">
			<p className="num text-xs text-text-2">
				ロット 買値 {formatInt(lot.entryPrice)} 円 ・ {formatBtc(lot.quantity)}{" "}
				BTC{" "}
				<span className={change >= 0 ? "text-profit" : "text-loss"}>
					{distanceText(price, lot.entryPrice)}
				</span>
				{lot.partialDone && " ・ 一部利確済み"}
			</p>
			{lot.selling || !lot.groups ? (
				<p className="py-1.5 text-xs text-text-2">売り注文の約定待ち</p>
			) : (
				(["stopLoss", "takeProfit", "partialTakeProfit"] as const).map((k) => {
					const g = lot.groups?.[k];
					if (!g || (k !== "stopLoss" && g.conditions.length === 0)) {
						return null;
					}
					return (
						<GroupRow
							key={k}
							id={key(k)}
							kind={k}
							group={g}
							price={price}
							open={open.has(key(k))}
							onToggle={onToggle}
							extra={
								k === "stopLoss" && lot.breakeven !== null
									? `建値ストップ: 買値 ${formatInt(lot.breakeven)} 円を下回ると残りを損切り`
									: null
							}
						/>
					);
				})
			)}
		</div>
	);
}

function BuyBlock({
	strategyId,
	buy,
	price,
	open,
	onToggle,
}: {
	strategyId: number;
	buy: WatchBuy;
	price: number;
	open: Set<string>;
	onToggle: (id: string, open: boolean) => void;
}) {
	const why = buyStatusText(buy.status);
	const willBuy = buy.status.kind === "ready" && buy.buy.met === true;
	const key = `${strategyId}:${buy.id}::buy`;
	return (
		<section
			aria-label={`買い ${buy.name}`}
			className="rounded-[10px] border border-line px-2.5 py-1.5"
		>
			<div className="flex flex-wrap items-center gap-2 py-1">
				<h3 className="text-sm font-bold">{buy.name}</h3>
				<span className="num text-xs text-text-2">
					保有 {buy.holding}/{buy.maxPositions}
				</span>
				{(why || willBuy) && (
					<span
						className={`ml-auto rounded px-1.5 py-px text-[11px] ${willBuy ? "bg-buy/12 font-semibold text-buy" : "bg-surface-2 text-text-2"}`}
					>
						{willBuy ? "次の判定で買う" : why}
					</span>
				)}
			</div>
			<GroupRow
				id={key}
				kind="buy"
				group={buy.buy}
				price={price}
				open={open.has(key)}
				onToggle={onToggle}
			/>
			{buy.lots.map((lot) => (
				<LotBlock
					key={lot.id}
					strategyId={strategyId}
					buyId={buy.id}
					lot={lot}
					price={price}
					open={open}
					onToggle={onToggle}
				/>
			))}
		</section>
	);
}

/** チャートの下に置く、買いごと・グループごとの条件の一覧。グループは畳める */
export function StrategyWatchPanel({
	strategyId,
	watch,
}: {
	strategyId: number;
	watch: StrategyWatch;
}) {
	const [open, setOpen] = useOpenGroups();
	return (
		<section
			aria-label="戦略の見張り"
			className={`${PANEL} gap-2 lg:col-span-2`}
		>
			<div className="flex min-h-6 items-center gap-1.5">
				<h2 className="text-[15px] font-bold">戦略の見張り</h2>
				<Help label="戦略の見張り">
					<p>
						戦略の条件を、今の価格（{formatInt(watch.price)}{" "}
						円）で試算した結果。✓ は成立、○ は不成立。
					</p>
					<p>
						「→」の後は、ほかの値はそのままに価格だけが動いたとき、その条件が成立する価格。
					</p>
				</Help>
				<span className="text-xs text-text-2">今の価格で試算</span>
			</div>
			{watch.buys.map((b) => (
				<BuyBlock
					key={b.id}
					strategyId={strategyId}
					buy={b}
					price={watch.price}
					open={open}
					onToggle={setOpen}
				/>
			))}
		</section>
	);
}
