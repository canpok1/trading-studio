// 候補が2つ以上のバックテスト結果の部品（ADR 0037）。銘柄ごとの成績・総資産の推移

import type { BacktestRun, EquityPoint } from "@trading-studio/backend";
import type { Currency, Instrument } from "@trading-studio/core";
import {
	formatAmount,
	formatQuantity,
	gradeProfitFactor,
	gradeWinRate,
} from "@trading-studio/core";
import { FewTradesNote } from "../../../shared/components/Grade";
import { Stat } from "../../../shared/components/OrderViews";
import { formatDate } from "../../../shared/lib/format";
import {
	formatSignedAmount,
	formatSignedPercent,
	holdingText,
} from "../../../shared/lib/number";

type Summary = NonNullable<BacktestRun["summary"]>;

/** 画面で銘柄を短く指す名前（BTC・ETH…） */
export const instrumentLabel = (i: Instrument) => i.quantityUnit;

const tone = (n: number) => (n >= 0 ? "text-profit" : "text-loss");

const COLS = "grid grid-cols-[3rem_minmax(0,1fr)_2.5rem_3.5rem] gap-2";

/** 銘柄ごとの損益・取引・勝率。行を押すとその銘柄へ切り替える */
export function InstrumentTable({
	run,
	onPick,
}: {
	run: BacktestRun;
	onPick: (id: string) => void;
}) {
	const by = run.summary?.byInstrument ?? {};
	const { currency } = run.instrument;
	return (
		<div className="flex flex-col border-t border-line pt-2">
			<div
				className={`${COLS} px-1 pb-1 text-xs text-text-2`}
				aria-hidden="true"
			>
				<span>銘柄</span>
				<span className="text-right">損益</span>
				<span className="text-right">取引</span>
				<span className="text-right">勝率</span>
			</div>
			<ul aria-label="銘柄ごとの成績">
				{run.instruments.map((i) => {
					const s = by[i.id];
					if (!s) return null;
					return (
						<li key={i.id} className="border-t border-line">
							<button
								type="button"
								onClick={() => onPick(i.id)}
								aria-label={`${instrumentLabel(i)} 損益 ${formatSignedAmount(currency, s.pnl)}${currency.unit}・取引 ${s.trades}・勝率 ${s.winRate !== null ? `${s.winRate.toFixed(1)}%` : "—"}`}
								className={`${COLS} num w-full items-center px-1 py-2 text-left text-[13px] hover:bg-surface-2`}
							>
								<span className="font-semibold">{instrumentLabel(i)}</span>
								<span
									className={`text-right font-semibold [overflow-wrap:anywhere] ${tone(s.pnl)}`}
								>
									{formatSignedAmount(currency, s.pnl)}
									{currency.unit}
								</span>
								<span className="text-right">{s.trades}</span>
								<span className="text-right">
									{s.winRate !== null ? `${s.winRate.toFixed(1)}%` : "—"}
								</span>
							</button>
						</li>
					);
				})}
			</ul>
			<p className="pt-1 text-xs text-text-2">行を押すとその銘柄に切り替わる</p>
		</div>
	);
}

/** 1銘柄の成績。銘柄ごとの元手は無いので、損益率と最大DDは出さない */
export function InstrumentSummaryCard({
	run,
	instrument,
}: {
	run: BacktestRun;
	instrument: Instrument;
}) {
	const s = (run.summary as Summary).byInstrument?.[instrument.id];
	const { currency } = run.instrument;
	return (
		<section
			aria-label="成績の要約"
			className="flex flex-col gap-3.5 rounded-xl border border-line bg-surface px-4 py-3.5"
		>
			<h2 className="text-[15px] font-bold">成績（{instrument.symbol}）</h2>
			{s ? (
				<>
					<div className="flex flex-col gap-0.5">
						<span className="text-xs text-text-2">損益</span>
						<span
							className={`num text-[30px] font-semibold tracking-tight ${tone(s.pnl)}`}
						>
							{formatSignedAmount(currency, s.pnl)}
							{currency.unit}
						</span>
						{s.buyHoldPercent !== null && (
							<span className="num text-xs text-text-2">
								ガチホなら {formatSignedPercent(s.buyHoldPercent)}（
								{instrumentLabel(instrument)} だけを持ち続けた場合）
							</span>
						)}
					</div>
					<div className="grid grid-cols-3 gap-x-2 gap-y-3 border-t border-line pt-3">
						<Stat
							label="勝率"
							value={s.winRate !== null ? `${s.winRate.toFixed(1)}%` : "—"}
							sub={`${s.wins}勝 ${s.losses}敗`}
							grade={gradeWinRate(s.winRate)}
						/>
						<Stat
							label="損益比率（PF）"
							value={
								s.trades === 0
									? "—"
									: s.profitFactor === null
										? "∞"
										: s.profitFactor.toFixed(2)
							}
							grade={gradeProfitFactor(s.profitFactor, s.trades)}
						/>
						<Stat
							label="取引回数"
							value={String(s.trades)}
							sub={
								s.averageHoldingMs !== null
									? `平均保有 ${holdingText(s.averageHoldingMs)}`
									: "往復"
							}
						/>
					</div>
					<FewTradesNote trades={s.trades} />
					{s.openPositionQuantity > 0 && (
						<p className="text-xs text-text-2">
							期間の終わりに{" "}
							{formatQuantity(instrument, s.openPositionQuantity)}{" "}
							{instrument.quantityUnit}{" "}
							を保有していた。損益は最後の終値で評価し、取引回数・勝率には含めない。
						</p>
					)}
					<p className="text-xs text-text-2">
						損益率と最大DDは銘柄ごとの元手が無いので出さない（合計で見る）
					</p>
				</>
			) : (
				<p className="text-xs text-text-2">この銘柄の成績は無い</p>
			)}
		</section>
	);
}

const W = 320;
const H = 140;

/** 総資産の推移の線。点線は初期資金 */
export function EquityChart({
	points,
	initialCash,
	currency,
}: {
	points: readonly EquityPoint[];
	initialCash: number;
	currency: Currency;
}) {
	const first = points[0];
	const last = points.at(-1);
	if (!first || !last) {
		return <p className="text-xs text-text-2">総資産の記録が無い</p>;
	}
	const values = points.map((p) => p.value);
	const max = Math.max(initialCash, ...values);
	const min = Math.min(initialCash, ...values);
	const span = max - min || 1;
	const x = (i: number) =>
		points.length > 1 ? (i / (points.length - 1)) * W : W / 2;
	const y = (v: number) => H - ((v - min) / span) * H;
	const money = (v: number) => `${formatAmount(currency, v)}${currency.unit}`;
	return (
		<figure className="flex flex-col gap-1">
			<div className="num flex justify-between text-[11px] text-text-2">
				<span>最高 {money(max)}</span>
				<span>最後 {money(last.value)}</span>
			</div>
			<svg
				role="img"
				aria-label={`総資産の推移。初期資金 ${money(initialCash)}、最後 ${money(last.value)}`}
				viewBox={`0 0 ${W} ${H}`}
				preserveAspectRatio="none"
				className="h-36 w-full rounded-lg bg-surface-2"
			>
				<line
					x1={0}
					x2={W}
					y1={y(initialCash)}
					y2={y(initialCash)}
					strokeDasharray="4 4"
					vectorEffect="non-scaling-stroke"
					style={{ stroke: "var(--color-text-2)" }}
				/>
				<polyline
					fill="none"
					strokeWidth={2}
					vectorEffect="non-scaling-stroke"
					style={{ stroke: "var(--color-price)" }}
					points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ")}
				/>
			</svg>
			<div className="num flex justify-between text-[11px] text-text-2">
				<span>{formatDate(first.time)}</span>
				<span>最低 {money(min)}</span>
				<span>{formatDate(last.time)}</span>
			</div>
		</figure>
	);
}
