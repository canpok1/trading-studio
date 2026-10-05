// ホームの最上段に並べる要点。通算損益・含み損益・市場評価2つを小さなカードで出す

import type {
	AutoTradingStatus,
	CurrentJudgment,
	TradingPerformance,
} from "@trading-studio/backend";
import { JUDGE_LABELS, JUDGES } from "@trading-studio/core";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { gradePnl } from "../../lib/grade";
import { unrealizedPnl } from "../../lib/home";
import { formatSignedInt, formatSignedPercent } from "../../lib/number";
import { GradeBadge } from "../Grade";
import { JudgmentBadge } from "../judgment/JudgmentBadge";
import { Skeleton } from "../States";

/** 要点のカードの枠。自動取引のカードも同じ枠で並べる */
export const TILE =
	"flex min-w-0 flex-col gap-1 rounded-xl border border-line bg-surface px-3 py-2.5";

const tone = (v: number | null) =>
	v === null ? "" : v >= 0 ? "text-profit" : "text-loss";

function Tile({
	label,
	tag,
	children,
}: {
	label: string;
	tag?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section aria-label={label} className={TILE}>
			<h2 className="flex flex-wrap items-center gap-1.5 text-xs font-normal text-text-2">
				{label}
				{tag}
			</h2>
			{children}
		</section>
	);
}

/** 通算損益（口座のリセット以降。確定した分と保有の含み損益の合計） */
export function TotalPnlTile({
	performance: p,
	error,
}: {
	performance: TradingPerformance | null;
	error: string | null;
}) {
	return (
		<Tile
			label="通算損益"
			tag={
				p && (
					<GradeBadge
						value={gradePnl(
							p.pnlPercent,
							p.buyHoldPercent,
							p.trades === 0 && p.position.quantity === 0,
						)}
					/>
				)
			}
		>
			{p === null ? (
				error ? (
					<p role="alert" className="text-xs font-semibold text-loss">
						読み込めなかった。5秒ごとに読み直している
					</p>
				) : (
					<Skeleton className="h-11" />
				)
			) : (
				<>
					<span
						data-testid="home-pnl"
						className={`num text-xl font-semibold tracking-tight ${tone(p.pnl)}`}
					>
						{p.pnl === null ? "—" : `${formatSignedInt(p.pnl)}円`}
					</span>
					<span className="num text-xs text-text-2">
						<span
							data-testid="home-pnl-percent"
							className={`font-semibold ${tone(p.pnlPercent)}`}
						>
							{p.pnlPercent === null ? "—" : formatSignedPercent(p.pnlPercent)}
						</span>
						{p.buyHoldPercent !== null &&
							`（ガチホ ${formatSignedPercent(p.buyHoldPercent)}）`}
					</span>
				</>
			)}
		</Tile>
	);
}

/** 含み損益（保有中のロットの合計）。手数料を含めず、今の価格で評価する */
export function UnrealizedPnlTile({
	status,
	price,
}: {
	status: AutoTradingStatus;
	price: number | null;
}) {
	const { quantity, entryPrice } = status.account.position;
	const pnl = unrealizedPnl(quantity, entryPrice, price);
	const lots = status.account.lots.length;
	return (
		<Tile label="含み損益">
			<span
				data-testid="home-unrealized"
				className={`num text-xl font-semibold tracking-tight ${tone(pnl)}`}
			>
				{pnl === null ? "—" : `${formatSignedInt(pnl)}円`}
			</span>
			<span className="text-xs text-text-2">
				{lots > 0 ? `保有 ${lots} ロット` : "保有なし"}
			</span>
		</Tile>
	);
}

/** 今の市場評価。観点ごとに1枚。押すとニュース画面へ */
export function JudgmentTiles({
	current,
}: {
	current: CurrentJudgment | null;
}) {
	return JUDGES.map((j) => {
		const r = current?.results[j];
		return (
			<Link
				key={j}
				to="/news"
				aria-label={`${JUDGE_LABELS[j]}（ニュースへ）`}
				data-testid={`home-judge-${j}`}
				className={`${TILE} hover:bg-surface-2`}
			>
				<span className="text-xs text-text-2">{JUDGE_LABELS[j]}</span>
				{r === undefined ? (
					<Skeleton className="h-11" />
				) : (
					<>
						<span className="flex">
							<JudgmentBadge judge={j} value={r.value} />
						</span>
						<span className="num text-xs text-text-2">
							{r.average === null ? "—" : `${r.average}点`} ›
						</span>
					</>
				)}
			</Link>
		);
	});
}
