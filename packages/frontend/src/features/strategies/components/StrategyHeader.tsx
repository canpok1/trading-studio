// 戦略の画面の最上部。名前・状態・自動取引のオンオフ・編集への入口を1枚に置き、止まっている理由・編集できない理由があるときだけ下に添える。
// 名前の変更・複製・削除はたまにしか使わないので「⋯」に入れる

import type {
	AutoTradingStatus,
	StoredStrategy,
} from "@trading-studio/backend";
import { LIVE_AVAILABLE } from "@trading-studio/core";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Modal } from "../../../shared/components/Modal";
import { Button } from "../../../shared/components/ui";
import { useApi } from "../../../shared/lib/api";
import { formatClock } from "../../../shared/lib/format";
import { MODE_LABELS, useTradingStatus } from "../../../shared/lib/trading";
import { errorMessage, readJson } from "../../../shared/lib/useAsync";
import {
	CreateStrategyDialog,
	DeleteStrategyDialog,
	RenameStrategyDialog,
} from "./StrategyDialogs";

/** オフでも条件を変えられない理由。変えられるなら null */
export function editBlockReason(run: AutoTradingStatus): string | null {
	const { lots, openOrderCount } = run.account;
	if (lots.length > 0) {
		return `保有が ${lots.length} ロットあるため編集できない。売り切るか口座をリセットすると編集できる`;
	}
	if (openOrderCount > 0) {
		return `未約定の注文が ${openOrderCount} 件あるため編集できない。約定か取消を待つか、口座をリセットすると編集できる`;
	}
	return null;
}

export function StrategyHeader({
	run,
	onToast,
}: {
	run: AutoTradingStatus;
	onToast: (message: string) => void;
}) {
	const api = useApi();
	const navigate = useNavigate();
	const { set, drop, refresh } = useTradingStatus();
	const [dialog, setDialog] = useState<
		"start" | "menu" | "rename" | "copy" | "delete" | null
	>(null);
	const [busy, setBusy] = useState(false);
	const on = run.enabled;
	const unavailable = run.mode === "live" && !LIVE_AVAILABLE;
	const label = MODE_LABELS[run.mode];
	const id = String(run.id);
	const now = Date.now();
	const blocked = on ? null : editBlockReason(run);

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
	return (
		<section
			aria-label="自動取引設定"
			className="flex flex-col gap-2.5 lg:col-span-2"
		>
			<div className="flex items-center gap-3 rounded-xl bg-surface p-3.5">
				<div className="flex min-w-0 flex-1 flex-col">
					<h1 className="truncate text-[17px] font-bold">{run.name}</h1>
					<span className="text-xs text-text-2">
						<span data-testid="auto-state">
							{unavailable
								? "リアル取引はまだ使えない"
								: on
									? "稼働中"
									: "停止中"}
						</span>
						・{label}
					</span>
				</div>
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
				{!on && (
					<Button
						size="sm"
						disabled={blocked !== null}
						onClick={() => navigate(`/strategies/${run.id}/edit`)}
					>
						編集
					</Button>
				)}
				<button
					type="button"
					aria-label="戦略の設定"
					onClick={() => setDialog("menu")}
					className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line text-base font-bold text-text-2 hover:bg-surface-2"
				>
					⋯
				</button>
			</div>
			{blocked && (
				<p className="rounded-xl bg-warn px-3.5 py-3 text-xs leading-relaxed">
					{blocked}
				</p>
			)}
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
			{dialog === "menu" && (
				<Modal title={`「${run.name}」の設定`} onClose={() => setDialog(null)}>
					<Button onClick={() => setDialog("rename")}>
						戦略の名前を変える
					</Button>
					<Button onClick={() => setDialog("copy")}>戦略を複製する</Button>
					{!on && (
						<Button className="text-loss" onClick={() => setDialog("delete")}>
							戦略を削除
						</Button>
					)}
					<Button onClick={() => setDialog(null)}>閉じる</Button>
				</Modal>
			)}
			{dialog === "rename" && (
				<RenameStrategyDialog
					run={run}
					onClose={() => setDialog(null)}
					onDone={() => {
						setDialog(null);
						refresh();
						onToast("戦略の名前を変えた");
					}}
				/>
			)}
			{dialog === "copy" && (
				<CreateStrategyDialog
					copyFrom={run}
					onClose={() => setDialog(null)}
					onCreated={(s: StoredStrategy) => {
						refresh();
						navigate(`/strategies/${s.id}/edit`);
					}}
				/>
			)}
			{dialog === "delete" && (
				<DeleteStrategyDialog
					run={run}
					onClose={() => setDialog(null)}
					onDone={() => {
						drop(run.id);
						navigate("/strategies", {
							replace: true,
							state: { notice: `「${run.name}」を削除した` },
						});
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
