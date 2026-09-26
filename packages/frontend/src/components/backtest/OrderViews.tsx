// 注文の一覧の行と詳細

import type { BacktestOrder } from "@trading-studio/core";
import { formatBtc } from "@trading-studio/core";
import { formatDateTime } from "../../format";
import { formatInt, formatSignedInt } from "../../lib/number";
import { Modal } from "../Modal";
import { Button } from "../ui";

const STATUS_LABEL: Record<BacktestOrder["status"], string> = {
	filled: "約定",
	open: "注文中",
	canceled: "取消",
};

/**
 * 売りのきっかけになった条件（例: EMA12/48下抜け、−2%）。戦略の理由から読む。
 * 「利確」「損切り」のグループ名で出すと、利確のグループの条件で損失が出た売りも「利確」と読めてしまうため、条件名で出す
 */
export function orderKind(o: BacktestOrder): string | null {
	if (o.side !== "sell") return null;
	const hits: string[] = [];
	for (const m of o.reason.matchAll(
		/短期EMA\((\d+)\)[^。]*?長期EMA\((\d+)\)[^。]*?を(上抜け|下抜け)/g,
	)) {
		hits.push(`EMA${m[1]}/${m[2]}${m[3]}`);
	}
	for (const m of o.reason.matchAll(
		/直近 (\d+) 本の(最高値|最安値)[^。]*?を(上抜け|下抜け)/g,
	)) {
		hits.push(`${m[1]}本の${m[2] === "最高値" ? "高値上抜け" : "安値下抜け"}`);
	}
	for (const m of o.reason.matchAll(/（([+−][\d.]+%) 以上）/g)) {
		hits.push(m[1] as string);
	}
	if (hits.length > 0) return hits.join("・");
	if (o.reason.includes("損切り")) return "損切り";
	if (o.reason.includes("利確")) return "利確";
	return null;
}

/** 一覧に出す時刻。約定・取消・発注のうち最後の状態のもの */
function orderTime(o: BacktestOrder): number {
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

export function OrderRow({
	order: o,
	selected,
	onClick,
}: {
	order: BacktestOrder;
	selected: boolean;
	onClick: () => void;
}) {
	const kind = orderKind(o);
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
				<span className="text-sm font-semibold">
					<SideText order={o} />{" "}
					{o.type === "limit" && o.status !== "filled" ? "指値 " : ""}
					{formatBtc(o.quantity)} · {STATUS_LABEL[o.status]}
					{kind ? ` · ${kind}` : ""}
				</span>
				<span className="num text-xs text-text-2">
					{formatDateTime(orderTime(o))}
					{price !== null ? ` · @${formatInt(price)}` : ""}
				</span>
			</span>
			<span className="num text-right text-[13px] font-semibold">
				{o.pnl !== null ? (
					<span className={o.pnl >= 0 ? "text-profit" : "text-loss"}>
						{formatSignedInt(o.pnl)}
					</span>
				) : (
					<span className="font-normal text-text-2">
						{STATUS_LABEL[o.status]}
					</span>
				)}
			</span>
		</button>
	);
}

export function OrderSheet({
	order: o,
	onClose,
	onPair,
}: {
	order: BacktestOrder;
	onClose: () => void;
	onPair: (id: string) => void;
}) {
	const kind = orderKind(o);
	const price = o.fillPrice ?? o.price;
	return (
		<Modal title="注文の詳細" onClose={onClose}>
			<div className="flex items-center gap-2.5">
				<OrderIcon order={o} size={20} />
				<div className="flex flex-1 flex-col">
					<strong className="text-[17px]">
						<SideText order={o} long /> · {STATUS_LABEL[o.status]}
						{kind ? ` · ${kind}` : ""}
					</strong>
					<span className="num text-xs text-text-2">
						{formatDateTime(orderTime(o))} ·{" "}
						{o.type === "limit" ? "指値" : "成行"}
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
}: {
	label: string;
	value: string;
	sub?: string;
	tone?: string;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<span className="text-xs text-text-2">{label}</span>
			<span className={`num text-[15px] font-semibold ${tone}`}>{value}</span>
			{sub && <span className="num text-[11px] text-text-2">{sub}</span>}
		</div>
	);
}
