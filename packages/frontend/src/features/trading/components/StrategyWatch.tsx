// ホームの「次の動き」（チャートの上）と「戦略の見張り」（チャートの下）。
// 戦略を今の価格で試算し、価格がいくらになれば何が起きるかと、条件ごとの今の値を出す

import type {
	Instrument,
	StrategyWatch,
	WatchBuy,
	WatchCondition,
	WatchGroup,
	WatchLot,
	WatchMove,
} from "@trading-studio/core";
import { formatPrice, formatQuantity } from "@trading-studio/core";
import { useCallback, useState } from "react";
import { Help } from "../../../shared/components/Help";
import { conditionText } from "../../../shared/lib/condition-text";
import type { TriggerView } from "../../../shared/lib/strategy-watch";
import {
	ACTION_LABELS,
	buyStatusText,
	distanceText,
	metCount,
	STOPPED_TEXT,
	triggerView,
} from "../../../shared/lib/strategy-watch";
import { PANEL } from "./Panel";

/** 種類のバッジ。買い系は寒色、売り系は暖色（利確は明るい橙・損切りは暗い赤茶）。出している売りの注文は利確か損切りか持たないので無彩色 */
const KIND_BADGE: Record<WatchMove["kind"], string> = {
	sell: "bg-surface-2 text-text-2",
	entry: "bg-buy/12 text-buy",
	partialTakeProfit: "bg-take-profit-bg text-take-profit",
	takeProfit: "bg-take-profit-bg text-take-profit",
	stopLoss: "bg-stop-loss-bg text-stop-loss",
};

export function KindBadge({
	kind,
	buyName,
	multi,
	nameClass = "",
}: {
	kind: WatchMove["kind"];
	buyName: string;
	multi: boolean;
	/** 買いの名前に付けるクラス。狭いところで隠すのに使う */
	nameClass?: string;
}) {
	return (
		<span
			className={`rounded px-1.5 py-px text-[11px] font-semibold ${KIND_BADGE[kind]}`}
		>
			{/* 買いの名前は長いと幅に収まらないので、名前の中だけ折り返す */}
			<span className="whitespace-nowrap">{ACTION_LABELS[kind]}</span>
			{multi && <span className={nameClass}>「{buyName}」</span>}
		</span>
	);
}

const ICON_CLASS: Record<TriggerView["icon"], string> = {
	"●": "text-text-2",
	"↑": "font-bold text-profit",
	"↓": "font-bold text-loss",
	"⏱": "text-text-2",
	"◇": "text-text-2",
	"…": "text-text-2",
};

/**
 * 次の動き1行。「一部利確 ↑ +10.00%待ち」。種類を先に置き、入らなければきっかけを次の行へ折り返す。
 * detailed（戦略の画面）なら円の差・今の値も添える（「+10.00%（+1,000,000 円）待ち」）。買いが2つ以上なら種類に買いの名前を添える
 */
export function MoveRow({
	move,
	instrument,
	price,
	multi,
	detailed,
	nameClass,
	tag,
}: {
	move: WatchMove;
	instrument: Instrument;
	price: number;
	multi: boolean;
	detailed: boolean;
	nameClass?: string;
	/** 候補が2つ以上の戦略で、どの銘柄の動きかを添える */
	tag?: string;
}) {
	const t = triggerView(move.trigger, price, instrument);
	return (
		<span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
			<KindBadge
				kind={move.kind}
				buyName={move.buyName}
				multi={multi}
				nameClass={nameClass}
			/>
			{tag && <span className="font-semibold">{tag}</span>}
			<span className="flex items-baseline gap-x-0.5">
				<span aria-hidden className={ICON_CLASS[t.icon]}>
					{t.icon}
				</span>
				<span
					className={
						move.trigger.kind === "price" || move.trigger.kind === "order"
							? "num"
							: ""
					}
				>
					{t.text}
					{detailed && t.note && (
						<span className="text-xs text-text-2">（{t.note}）</span>
					)}
					{t.suffix}
				</span>
			</span>
		</span>
	);
}

/** チャートの上に置く次の動き。行動ごとのきっかけを優先度の高い順に全部出す */
export function NextMovesCard({
	watch,
	instrument,
	stopped,
	className = "",
}: {
	watch: StrategyWatch;
	instrument: Instrument;
	/** オフ。判定しないので、出している注文だけを出す */
	stopped: boolean;
	className?: string;
}) {
	const multi = watch.buys.length >= 2;
	const moves = stopped
		? watch.moves.filter((m) => m.trigger.kind === "order")
		: watch.moves;
	return (
		<section aria-label="次の動き" className={`${PANEL} gap-2 ${className}`}>
			<div className="flex min-h-6 items-center gap-1.5">
				<h2 className="text-[15px] font-bold">次の動き</h2>
				<Help label="次の動き">
					<p>
						戦略を今の価格で試算し、行動（買いごとの
						買い・一部利確・利確・損切り）ごとに、何が起きたらその行動をするかを出す。
					</p>
					<p>
						並びは、次の判定で起きるもの、出している注文、価格（今の価格からの幅が小さい順）、時間、価格以外の条件、未成立の条件が多いもの、の順。買えない間（最大ロット数・損切り後の待ちなど）の買いは出さない。
					</p>
					<p>
						実際に注文するのは次の判定のとき。全部の条件はチャートの下の「戦略の見張り」で見る。
					</p>
				</Help>
			</div>
			<ul className="flex flex-col gap-1.5 text-sm">
				{stopped && <li className="text-text-2">{STOPPED_TEXT}</li>}
				{moves.map((m) => (
					<li key={`${m.buyId}:${m.kind}`}>
						<MoveRow
							move={m}
							instrument={instrument}
							price={watch.price}
							multi={multi}
							detailed
						/>
					</li>
				))}
				{!stopped && moves.length === 0 && (
					<li className="text-text-2">次の動きなし</li>
				)}
			</ul>
		</section>
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

function ConditionRow({
	c,
	instrument,
	price,
}: {
	c: WatchCondition;
	instrument: Instrument;
	price: number;
}) {
	const edge = c.met === false ? c.edge : null;
	return (
		<li className="grid grid-cols-[18px_1fr] gap-x-1.5 border-t border-dashed border-grid py-1.5 text-[13px] sm:grid-cols-[18px_1fr_auto]">
			<MetMark met={c.met} />
			<span>{conditionText(c.condition)}</span>
			<span className="num col-start-2 text-xs text-text-2 sm:col-start-3 sm:text-right">
				{c.detail}
				{edge &&
					`${c.detail ? " → " : ""}${formatPrice(instrument, edge.price)} ${instrument.currency.unit}（${distanceText(edge.price, price)}）`}
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
function groupSummary(
	g: WatchGroup,
	instrument: Instrument,
	price: number,
): string {
	if (g.met === null) return "判定できない";
	if (g.met) return "成立";
	const nearest = [...g.triggers].sort(
		(a, b) => Math.abs(a - price) - Math.abs(b - price),
	)[0];
	if (nearest !== undefined) {
		return `${formatPrice(instrument, nearest)} ${instrument.currency.unit}（${distanceText(nearest, price)}）`;
	}
	const { met, total } = metCount(g);
	return `${met}/${total} 成立`;
}

function GroupRow({
	id,
	kind,
	group,
	instrument,
	price,
	open,
	onToggle,
	extra,
}: {
	id: string;
	kind: keyof typeof GROUP_TITLES;
	group: WatchGroup;
	instrument: Instrument;
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
					{groupSummary(group, instrument, price)}
				</span>
			</summary>
			<ul className="pb-1.5 pl-[22px]">
				{group.conditions.map((c, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: 条件は並びで決まり、入れ替えない
					<ConditionRow key={i} c={c} instrument={instrument} price={price} />
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
	instrument,
	price,
	open,
	onToggle,
}: {
	strategyId: number;
	buyId: string;
	lot: WatchLot;
	instrument: Instrument;
	price: number;
	open: Set<string>;
	onToggle: (id: string, open: boolean) => void;
}) {
	const change = (price / lot.entryPrice - 1) * 100;
	const key = (g: string) => `${strategyId}:${buyId}:${lot.id}:${g}`;
	return (
		<div className="mt-1 border-t border-line pt-1.5">
			<p className="num text-xs text-text-2">
				ロット 買値 {formatPrice(instrument, lot.entryPrice)}{" "}
				{instrument.currency.unit} ・ {formatQuantity(instrument, lot.quantity)}{" "}
				{instrument.quantityUnit}{" "}
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
							instrument={instrument}
							price={price}
							open={open.has(key(k))}
							onToggle={onToggle}
							extra={
								k === "stopLoss" && lot.breakeven !== null
									? `建値ストップ: 買値 ${formatPrice(instrument, lot.breakeven)} ${instrument.currency.unit}を下回ると残りを損切り`
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
	instrument,
	price,
	open,
	onToggle,
}: {
	strategyId: number;
	buy: WatchBuy;
	instrument: Instrument;
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
				instrument={instrument}
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
					instrument={instrument}
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
	instrument,
}: {
	strategyId: number;
	watch: StrategyWatch;
	instrument: Instrument;
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
						戦略の条件を、今の価格（{formatPrice(instrument, watch.price)}{" "}
						{instrument.currency.unit}）で試算した結果。✓ は成立、○ は不成立。
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
					instrument={instrument}
					price={watch.price}
					open={open}
					onToggle={setOpen}
				/>
			))}
		</section>
	);
}
