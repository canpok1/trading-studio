// ホームの自動取引のカード。選んでいる戦略のオンオフと状態・戦略名を1行で出し、止まっている理由があるときだけ添える。
// 戦略の名前の変更・削除はたまにしか使わないので「⋯」の設定に入れる

import type { AutoTradingStatus } from "@trading-studio/backend";
import { LIVE_AVAILABLE } from "@trading-studio/core";
import { useState } from "react";
import { Link } from "react-router";
import { Modal } from "../../../shared/components/Modal";
import { Button } from "../../../shared/components/ui";
import { useApi } from "../../../shared/lib/api";
import { formatClock } from "../../../shared/lib/format";
import { useTradingStatus } from "../../../shared/lib/trading";
import { errorMessage, readJson } from "../../../shared/lib/useAsync";
import { DeleteRunDialog, RenameRunDialog } from "./RunDialogs";
import { TILE } from "./SummaryTiles";
import { MODE_LABELS } from "./TradeViews";

export function AutoTradingCard({
	run,
	onToast,
	onDeleted,
	className = "",
}: {
	run: AutoTradingStatus;
	onToast: (message: string) => void;
	onDeleted: () => void;
	className?: string;
}) {
	const api = useApi();
	const { set, drop, refresh } = useTradingStatus();
	const [dialog, setDialog] = useState<
		"start" | "settings" | "rename" | "delete" | null
	>(null);
	const [busy, setBusy] = useState(false);
	const on = run.enabled;
	const unavailable = run.mode === "live" && !LIVE_AVAILABLE;
	const label = MODE_LABELS[run.mode];
	const id = String(run.id);
	const now = Date.now();

	const send = async (
		call: () => Promise<{ status: AutoTradingStatus }>,
		done: (s: AutoTradingStatus) => string,
	) => {
		setBusy(true);
		try {
			const r = await call();
			set(r.status);
			onToast(done(r.status));
		} catch (e) {
			onToast(errorMessage(e));
		} finally {
			setBusy(false);
		}
	};

	const toggle = () => {
		if (on) {
			// 停止は確認なしで即時
			send(
				() =>
					api.api.trading.strategies[":id"].stop
						.$post({ param: { id } })
						.then((res) => readJson<{ status: AutoTradingStatus }>(res)),
				() => "自動取引を停止した。今から新しい注文は出ない",
			);
			return;
		}
		setDialog("start");
	};

	const start = () => {
		setDialog(null);
		send(
			() =>
				api.api.trading.strategies[":id"].start
					.$post({ param: { id } })
					.then((res) => readJson<{ status: AutoTradingStatus }>(res)),
			(s) =>
				`「${s.name}」を開始した。次の判定 ${s.nextEvalAt === null ? "—" : formatClock(s.nextEvalAt, Date.now())} から模擬売買する`,
		);
	};

	const loss = run.dailyLoss;
	const holding = run.strategyLock === "holding";
	return (
		<section aria-label="自動取引設定" className={`${TILE} ${className}`}>
			<div className="flex items-center gap-3">
				<button
					type="button"
					role="switch"
					aria-checked={on}
					aria-label="自動取引"
					disabled={busy || unavailable}
					onClick={toggle}
					className="flex h-8 w-14 shrink-0 items-center rounded-full bg-surface-2 p-[3px] transition-colors disabled:opacity-45 aria-checked:bg-accent"
				>
					<span
						className={`h-[26px] w-[26px] rounded-full bg-white shadow transition-transform ${on ? "translate-x-6" : ""}`}
					/>
				</button>
				<div className="flex min-w-0 flex-1 flex-col">
					<h2 className="text-[13px] font-bold">
						自動取引{" "}
						<span data-testid="auto-state" className="whitespace-nowrap">
							{unavailable
								? "リアル取引はまだ使えない"
								: on
									? "稼働中"
									: "停止中"}
						</span>
					</h2>
					<span
						data-testid="auto-strategy"
						className="truncate text-xs text-text-2"
					>
						{run.name}
					</span>
				</div>
				<button
					type="button"
					aria-label="戦略の設定"
					onClick={() => setDialog("settings")}
					className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line text-base font-bold text-text-2 hover:bg-surface-2"
				>
					⋯
				</button>
			</div>
			{on && run.waitingForMarket && (
				<p className="text-xs font-semibold">
					価格の収集が止まっているため、判定を待っている
				</p>
			)}
			{on && loss.blocked && (
				<p className="text-xs font-semibold text-loss">
					1日の損失上限に達したため、翌 0 時まで新しい買いを止めている
				</p>
			)}
			{dialog === "settings" && (
				<Modal title={`「${run.name}」の設定`} onClose={() => setDialog(null)}>
					{holding && (
						<p className="text-xs text-text-2">
							保有か未約定の注文がある間は、戦略の条件を変えられない
						</p>
					)}
					<Link
						to={`/strategies/${run.id}`}
						className="flex h-11 items-center justify-center rounded-[10px] border border-line text-sm font-semibold"
					>
						条件を見る・変える
					</Link>
					<Button onClick={() => setDialog("rename")}>
						戦略の名前を変える
					</Button>
					{!on && (
						<Button className="text-loss" onClick={() => setDialog("delete")}>
							戦略を削除
						</Button>
					)}
					<Button onClick={() => setDialog(null)}>閉じる</Button>
				</Modal>
			)}
			{dialog === "rename" && (
				<RenameRunDialog
					run={run}
					onClose={() => setDialog(null)}
					onDone={() => {
						setDialog(null);
						refresh();
						onToast("戦略の名前を変えた");
					}}
				/>
			)}
			{dialog === "delete" && (
				<DeleteRunDialog
					run={run}
					onClose={() => setDialog(null)}
					onDone={() => {
						setDialog(null);
						drop(run.id);
						onDeleted();
						onToast(`「${run.name}」を削除した`);
					}}
				/>
			)}
			{dialog === "start" && (
				<Modal
					title={`「${run.name}」の自動取引を開始する（${label}）`}
					onClose={() => setDialog(null)}
				>
					<p className="leading-relaxed">
						{run.name} が、次の判定（
						{run.nextEvalAt === null ? "—" : formatClock(run.nextEvalAt, now)}
						）から
						{run.mode === "paper"
							? "最新の実データで模擬売買を始める。実資金は動かない。"
							: "実資金で売買を始める。"}
					</p>
					<Button variant="primary" onClick={start}>
						開始する
					</Button>
					<Button onClick={() => setDialog(null)}>やめる</Button>
				</Modal>
			)}
		</section>
	);
}
