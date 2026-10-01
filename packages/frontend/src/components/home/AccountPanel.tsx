// ホームの口座情報。総資産・現金・保有・平均取得・評価損益と、停止中だけ口座のリセット

import type {
	AutoTradingStatus,
	TradingPerformance,
} from "@trading-studio/backend";
import { formatBtc } from "@trading-studio/core";
import { useId, useState } from "react";
import { useApi } from "../../api";
import { formatDateTime } from "../../format";
import { formatInt, formatSignedInt } from "../../lib/number";
import { useTradingStatus } from "../../lib/trading";
import { errorMessage, readJson } from "../../lib/useAsync";
import { Stat } from "../backtest/OrderViews";
import { Modal } from "../Modal";
import { NumberInput } from "../NumberInput";
import { ModeTag } from "../trading/TradeViews";
import { Button } from "../ui";
import { PANEL, PanelHeader } from "./Panel";

/** リセットの確認で最初に入れておく開始時の資金（円） */
const DEFAULT_INITIAL_CASH = 1_000_000;

const tone = (v: number | null) =>
	v === null ? "" : v >= 0 ? "text-profit" : "text-loss";

/** 評価損益は手数料を含めず、今の価格で評価する。保有を押すとロットごとの一覧を出す */
export function AccountPanel({
	status,
	performance,
	price,
	onToast,
	onReset,
}: {
	status: AutoTradingStatus;
	performance: TradingPerformance | null;
	price: number | null;
	onToast: (message: string) => void;
	/** リセットできた後に呼ぶ。成績と注文は状態と別に読んでいるので、読み直してもらう */
	onReset: () => void;
}) {
	const api = useApi();
	const { set } = useTradingStatus();
	const [lotsOpen, setLotsOpen] = useState(false);
	const [resetting, setResetting] = useState(false);
	const [busy, setBusy] = useState(false);
	const { account } = status;
	const { quantity, entryPrice } = account.position;
	const lots = account.lots;
	const unrealized = (q: number, entry: number | null) =>
		q > 0 && entry !== null && price !== null
			? Math.round(((price - entry) * q) / 100_000_000)
			: null;
	const pnl = unrealized(quantity, entryPrice);

	const reset = async (initialCash: number) => {
		setResetting(false);
		setBusy(true);
		try {
			const r = await api.api.trading.runs[":id"].reset
				.$post({ param: { id: String(status.id) }, json: { initialCash } })
				.then((res) => readJson<{ status: AutoTradingStatus }>(res));
			set(r.status);
			onReset();
			onToast(
				`「${status.name}」の口座をリセットした。開始時の資金 ${formatInt(initialCash)}円`,
			);
		} catch (e) {
			onToast(errorMessage(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section aria-label="口座情報" className={`${PANEL} @container`}>
			<PanelHeader title="口座情報" tag={<ModeTag mode={status.mode} />} />
			<div className="flex flex-col gap-0.5">
				<span className="text-xs text-text-2">総資産</span>
				<span
					data-testid="account-equity"
					className="num text-[26px] font-semibold tracking-tight"
				>
					{performance?.equity == null
						? "—"
						: `${formatInt(performance.equity)}円`}
				</span>
			</div>
			{/* 4 列は、8 桁の価格と評価損益が横に並んでも重ならないパネル幅があるときだけにする */}
			<div className="grid grid-cols-2 gap-x-2 gap-y-3 @min-[28rem]:grid-cols-4">
				<Stat
					label="現金"
					value={performance ? `${formatInt(performance.cash)}円` : "—"}
				/>
				<button
					type="button"
					aria-label={`保有 ${formatBtc(quantity)} BTC${lots.length > 0 ? `（${lots.length} ロット）` : ""}`}
					disabled={lots.length === 0}
					onClick={() => setLotsOpen(true)}
					className="-m-1 rounded-lg p-1 text-left enabled:hover:bg-surface-2"
				>
					<Stat
						label="保有"
						value={`${formatBtc(quantity)} BTC`}
						sub={lots.length > 0 ? `${lots.length} ロット ›` : undefined}
					/>
				</button>
				<Stat
					label="平均取得"
					value={entryPrice === null ? "—" : `${formatInt(entryPrice)}円`}
				/>
				<Stat
					label="評価損益"
					value={pnl === null ? "—" : `${formatSignedInt(pnl)}円`}
					tone={tone(pnl)}
				/>
			</div>
			{!status.enabled && (
				<Button
					variant="link"
					className="self-start"
					disabled={busy}
					onClick={() => setResetting(true)}
				>
					口座をリセット
				</Button>
			)}
			{resetting && (
				<ResetModal onReset={reset} onClose={() => setResetting(false)} />
			)}
			{lotsOpen && (
				<Modal title="保有中のロット" onClose={() => setLotsOpen(false)}>
					<div className="overflow-hidden rounded-xl border border-line">
						{lots.map((l) => {
							const v = unrealized(l.quantity, l.entryPrice);
							return (
								<div
									key={l.id}
									className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-line bg-surface px-3.5 py-3 last:border-b-0"
								>
									<span className="flex min-w-0 flex-col gap-0.5">
										<span className="num text-sm font-semibold">
											買値 {formatInt(l.entryPrice)}円 · {formatBtc(l.quantity)}{" "}
											BTC
										</span>
										<span className="num text-xs text-text-2">
											{formatDateTime(l.openedAt)}
										</span>
									</span>
									<span className={`num text-[13px] font-semibold ${tone(v)}`}>
										{v === null ? "—" : `${formatSignedInt(v)}円`}
									</span>
								</div>
							);
						})}
					</div>
					<Button onClick={() => setLotsOpen(false)}>閉じる</Button>
				</Modal>
			)}
		</section>
	);
}

function ResetModal({
	onReset,
	onClose,
}: {
	onReset: (initialCash: number) => void;
	onClose: () => void;
}) {
	const id = useId();
	const [cash, setCash] = useState(DEFAULT_INITIAL_CASH);
	const valid = Number.isSafeInteger(cash) && cash >= 1;
	return (
		<Modal title="口座をリセットする" onClose={onClose}>
			<p className="leading-relaxed">
				資金・保有・未約定の注文を開始時の状態に戻す。過去の注文と約定の記録は残る。
			</p>
			<div className="flex flex-col gap-1.5">
				<label htmlFor={id} className="text-[13px] font-semibold">
					開始時の資金（円）
				</label>
				<NumberInput
					id={id}
					value={cash}
					onChange={setCash}
					format={formatInt}
					inputMode="numeric"
					invalid={!valid}
					className="h-11 text-left text-[15px]"
				/>
				{!valid && (
					<span className="text-xs font-semibold text-loss">
						1 円以上の整数で入れる
					</span>
				)}
			</div>
			<Button variant="primary" disabled={!valid} onClick={() => onReset(cash)}>
				リセットする
			</Button>
			<Button onClick={onClose}>やめる</Button>
		</Modal>
	);
}
