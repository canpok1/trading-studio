// 注文の一覧の行と詳細

import type { BacktestOrder, ExitKind } from "@trading-studio/core";
import { formatBtc, sellReasonPart } from "@trading-studio/core";
import type { ReactNode } from "react";
import { Fragment } from "react";
import { formatDateTime } from "../../format";
import type { GradeBadgeValue } from "../../lib/grade";
import { formatInt, formatSignedInt } from "../../lib/number";
import { GradeBadge } from "../Grade";
import { Modal } from "../Modal";
import { Button } from "../ui";

const STATUS_LABEL: Record<BacktestOrder["status"], string> = {
	filled: "約定",
	open: "注文中",
	canceled: "取消",
};

/** 成り立った条件の文を、バッジに出す短い名前にする。名前は結果の条件の要約（conditionText）と揃える。知らない形の文は null */
function conditionName(why: string): string | null {
	const patterns: [RegExp, (m: RegExpMatchArray) => string][] = [
		[
			/短期EMA\((\d+)\).*長期EMA\((\d+)\).*を(上抜け|下抜け)$/,
			(m) => `EMA${m[1]}/${m[2]}${m[3]}`,
		],
		[
			/直近 (\d+) 本の(最高値|最安値)/,
			(m) => `${m[1]}本の${m[2] === "最高値" ? "高値上抜け" : "安値下抜け"}`,
		],
		[/^RSI\((\d+)\) .* (\S+) (以上|以下)$/, (m) => `RSI${m[1]} ${m[2]}${m[3]}`],
		[/EMA\((\d+)\) \S+ より(上|下)$/, (m) => `EMA${m[1]}より${m[2]}`],
		[
			/ボリンジャーバンド\((\d+)本・([\d.]+)σ\)の(上限|下限)/,
			(m) => `BB${m[1]}/${m[2]}σ${m[3] === "上限" ? "上限以上" : "下限以下"}`,
		],
		[/^(.+)判定が(.+?)（/, (m) => `${m[1]}${m[2]}`],
		[/買ってからの最高値 .*（(−[\d.]+%) 以上）$/, (m) => `最高値${m[1]}`],
		[/買値 .*（([+−][\d.]+%) 以上）$/, (m) => m[1] as string],
		[/買ってから \d+ 本経過（(\d+) 本以上）$/, (m) => `${m[1]}本保有`],
	];
	for (const [re, name] of patterns) {
		const m = why.match(re);
		if (m) return name(m);
	}
	return null;
}

const EXIT_LABEL: Record<ExitKind, string> = {
	partialTakeProfit: "一部利確",
	takeProfit: "利確",
	stopLoss: "損切り",
};

/**
 * 売りのバッジの中身。どのグループ（一部利確・利確・損切り）で売ったかと、成り立った条件の名前（例: EMA12/48下抜け、−2%）。
 * 利確のグループの条件で損失が出た売りもあるため、グループ名だけでなく条件名も出す。どちらも分からなければ null
 */
export function exitBadge(
	o: ListedOrder,
): { kind: ExitKind | null; text: string } | null {
	if (o.side !== "sell") return null;
	const kind = o.exitKind ?? null;
	const part = sellReasonPart(o.reason, o.lotPrice ?? null);
	const names = (part?.slice(0, -1) ?? [])
		.map(conditionName)
		.filter((n) => n !== null);
	const text = [kind ? EXIT_LABEL[kind] : null, names.join("・") || null]
		.filter((x) => x !== null)
		.join(": ");
	return text ? { kind, text } : null;
}

/** 売りのバッジ。一覧の行では1行に収めて省略し、詳細（wrap）では折り返して全部出す */
export function ExitBadge({
	order,
	wrap = false,
}: {
	order: ListedOrder;
	wrap?: boolean;
}) {
	const b = exitBadge(order);
	if (!b) return null;
	const tone =
		b.kind === "takeProfit" || b.kind === "partialTakeProfit"
			? "bg-take-profit-bg text-take-profit"
			: b.kind === "stopLoss"
				? "bg-stop-loss-bg text-stop-loss"
				: "bg-surface-2 text-text-2";
	return (
		<span
			data-testid="exit-badge"
			className={`inline-block max-w-full rounded-full px-2 py-0.5 align-middle text-xs font-semibold ${wrap ? "" : "truncate"} ${tone}`}
		>
			{b.text}
		</span>
	);
}

/** 一覧に出す時刻。約定・取消・発注のうち最後の状態のもの */
export function orderTime(o: BacktestOrder): number {
	return o.status === "filled"
		? (o.filledAt as number)
		: o.status === "canceled"
			? (o.canceledAt as number)
			: o.placedAt;
}

export function OrderIcon({
	order,
	size = 14,
}: {
	order: BacktestOrder;
	size?: number;
}) {
	const buy = order.side === "buy";
	const fill =
		order.status === "canceled"
			? "var(--color-cancel)"
			: buy
				? "var(--color-buy)"
				: "var(--color-sell)";
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			aria-hidden="true"
			style={{ fill }}
		>
			{order.status === "filled" ? (
				<polygon points={buy ? "2,14 14,14 8,2" : "2,2 14,2 8,14"} />
			) : order.status === "open" ? (
				<circle cx="8" cy="8" r="6" />
			) : (
				<rect x="2.5" y="2.5" width="11" height="11" rx="1" />
			)}
		</svg>
	);
}

function SideText({ order, long }: { order: BacktestOrder; long?: boolean }) {
	const buy = order.side === "buy";
	return (
		<span className={buy ? "text-buy" : "text-sell"}>
			{buy ? (long ? "買い" : "買") : long ? "売り" : "売"}
		</span>
	);
}

/** 一覧に出す注文。売りには売るロットの買値（lotPrice）が添えられていることがある */
type ListedOrder = BacktestOrder & { lotPrice?: number | null };

/** 売りが売るロットの説明。ロットの買値が分からなければ空 */
const lotText = (o: ListedOrder) =>
	o.side === "sell" && o.lotPrice != null
		? ` · 買値 ${formatInt(o.lotPrice)} のロット`
		: "";

export function OrderRow({
	order: o,
	selected,
	onClick,
	tag,
}: {
	order: ListedOrder;
	selected: boolean;
	onClick: () => void;
	/** 損益が無い行の右端に、状態の代わりに出すもの */
	tag?: ReactNode;
}) {
	const price = o.fillPrice ?? o.price;
	return (
		<button
			type="button"
			onClick={onClick}
			aria-current={selected || undefined}
			className="grid w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-line bg-surface px-3.5 py-3 text-left last:border-b-0 hover:bg-surface-2 aria-[current]:bg-surface-2 aria-[current]:shadow-[inset_3px_0_0_var(--color-accent)]"
		>
			<OrderIcon order={o} />
			<span className="flex min-w-0 flex-col gap-0.5">
				<span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
					<span className="shrink-0">
						<SideText order={o} />{" "}
						{o.type === "limit" && o.status !== "filled" ? "指値 " : ""}
						{formatBtc(o.quantity)} · {STATUS_LABEL[o.status]}
					</span>
					<ExitBadge order={o} />
				</span>
				<span className="num text-xs text-text-2">
					{formatDateTime(orderTime(o))}
					{price !== null ? ` · @${formatInt(price)}` : ""}
					{lotText(o)}
				</span>
			</span>
			<span className="num text-right text-[13px] font-semibold">
				{o.pnl !== null ? (
					<span className={o.pnl >= 0 ? "text-profit" : "text-loss"}>
						{formatSignedInt(o.pnl)}
					</span>
				) : (
					(tag ?? (
						<span className="font-normal text-text-2">
							{STATUS_LABEL[o.status]}
						</span>
					))
				)}
			</span>
		</button>
	);
}

export function OrderSheet({
	order: o,
	onClose,
	onPair,
	children,
}: {
	order: ListedOrder;
	onClose: () => void;
	onPair: (id: string) => void;
	/** 戦略の理由の後に足す欄 */
	children?: ReactNode;
}) {
	const price = o.fillPrice ?? o.price;
	return (
		<Modal title="注文の詳細" onClose={onClose}>
			<div className="flex items-center gap-2.5">
				<OrderIcon order={o} size={20} />
				<div className="flex flex-1 flex-col">
					<strong className="text-[17px]">
						<SideText order={o} long /> · {STATUS_LABEL[o.status]}
					</strong>
					<span className="flex min-w-0 py-0.5">
						<ExitBadge order={o} wrap />
					</span>
					<span className="num text-xs text-text-2">
						{formatDateTime(orderTime(o))} ·{" "}
						{o.type === "limit" ? "指値" : "成行"}
						{lotText(o)}
					</span>
				</div>
			</div>
			<div className="grid grid-cols-3 gap-2 rounded-[10px] bg-bg p-3">
				<Stat
					label={o.status === "filled" ? "約定価格" : "指値"}
					value={price !== null ? formatInt(price) : "—"}
				/>
				<Stat label="数量" value={formatBtc(o.quantity)} />
				{o.pnl !== null ? (
					<Stat
						label="損益"
						value={`${formatSignedInt(o.pnl)}円`}
						tone={o.pnl >= 0 ? "text-profit" : "text-loss"}
					/>
				) : (
					<Stat
						label="手数料"
						value={o.fee !== null ? `${formatInt(o.fee)}円` : "—"}
					/>
				)}
			</div>
			<div className="flex flex-col gap-1.5">
				<h3 className="text-xs font-semibold text-text-2">戦略の理由</h3>
				<p className="text-sm leading-relaxed">{o.reason}</p>
				{o.cancelReason && (
					<p className="text-sm leading-relaxed">{o.cancelReason}</p>
				)}
			</div>
			{children}
			{o.pairId && (
				<Button
					className="justify-between"
					onClick={() => onPair(o.pairId as string)}
				>
					<span>対応する{o.side === "buy" ? "売り" : "買い"}を見る</span>
					<span aria-hidden="true">›</span>
				</Button>
			)}
			<Button onClick={onClose}>閉じる</Button>
		</Modal>
	);
}

export function Stat({
	label,
	value,
	sub,
	tone = "",
	grade = null,
}: {
	label: string;
	value: string;
	sub?: string;
	tone?: string;
	/** 値の評価。ラベルの横にバッジで出す */
	grade?: GradeBadgeValue | null;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-text-2">
				{label}
				<GradeBadge value={grade} />
			</span>
			{/* 列の幅に収まらない桁数でも隣の列へはみ出さないよう、桁区切りの後ろで折り返す。区切りの無い値はどこでも折り返す */}
			<span
				className={`num text-[15px] font-semibold [overflow-wrap:anywhere] ${tone}`}
			>
				{value.split(/(?<=,)/).map((part, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: 値を区切っただけで、並びは変わらない
					<Fragment key={i}>
						{i > 0 && <wbr />}
						{part}
					</Fragment>
				))}
			</span>
			{sub && <span className="num text-[11px] text-text-2">{sub}</span>}
		</div>
	);
}
