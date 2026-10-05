// ホームの自動取引のカード。選んでいるタブのオンオフと状態・戦略名を1行で出し、止まっている理由があるときだけ添える。
// 運用する戦略の変更・タブの名前の変更・削除はたまにしか使わないので「⋯」の設定に入れる

import type {
	AutoTradingStatus,
	StoredStrategy,
} from "@trading-studio/backend";
import { validateConditionSet } from "@trading-studio/core";
import { useId, useState } from "react";
import { useApi } from "../../api";
import { formatClock } from "../../format";
import { useTradingStatus } from "../../lib/trading";
import { errorMessage, readJson } from "../../lib/useAsync";
import { Modal } from "../Modal";
import { LIVE_AVAILABLE, MODE_LABELS } from "../trading/TradeViews";
import { Button } from "../ui";
import { DeleteRunDialog, RenameRunDialog } from "./RunDialogs";
import { TILE } from "./SummaryTiles";

export function AutoTradingCard({
	run,
	strategies,
	canDelete,
	onToast,
	onDeleted,
	className = "",
}: {
	run: AutoTradingStatus;
	strategies: StoredStrategy[];
	/** タブは最低1つ残す */
	canDelete: boolean;
	onToast: (message: string) => void;
	onDeleted: () => void;
	className?: string;
}) {
	const api = useApi();
	const { set, drop } = useTradingStatus();
	const [dialog, setDialog] = useState<
		"start" | "settings" | "rename" | "delete" | null
	>(null);
	const selectId = useId();
	const [busy, setBusy] = useState(false);
	const on = run.enabled;
	const unavailable = run.mode === "live" && !LIVE_AVAILABLE;
	const label = MODE_LABELS[run.mode];
	const active = run.strategy;
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
					api.api.trading.runs[":id"].stop
						.$post({ param: { id } })
						.then((res) => readJson<{ status: AutoTradingStatus }>(res)),
				() => "自動取引を停止した。今から新しい注文は出ない",
			);
			return;
		}
		if (!active) {
			onToast("運用する戦略を選ぶと開始できる");
			return;
		}
		setDialog("start");
	};

	const start = () => {
		setDialog(null);
		send(
			() =>
				api.api.trading.runs[":id"].start
					.$post({ param: { id } })
					.then((res) => readJson<{ status: AutoTradingStatus }>(res)),
			(s) =>
				`「${s.name}」を開始した。次の判定 ${s.nextEvalAt === null ? "—" : formatClock(s.nextEvalAt, Date.now())} から模擬売買する`,
		);
	};

	const choose = (next: number | null) => {
		const s = strategies.find((x) => x.id === next);
		// 条件が足りない戦略は動かせないので、運用する戦略に選ばせない
		if (s && validateConditionSet(s.params).length > 0) {
			onToast("この戦略は条件が足りないため選べない。「戦略」の画面で直す");
			return;
		}
		send(
			() =>
				api.api.trading.runs[":id"]
					.$patch({ param: { id }, json: { strategyId: next } })
					.then((res) => readJson<{ status: AutoTradingStatus }>(res)),
			(r) =>
				`運用する戦略を${r.strategy ? `「${r.strategy.name}」に` : "未選択に"}した`,
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
						<span data-testid="auto-state">
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
						{active ? active.name : "戦略 未選択"}
					</span>
				</div>
				<button
					type="button"
					aria-label="タブの設定"
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
					<div className="flex flex-col gap-1.5">
						<label htmlFor={selectId} className="text-[13px] font-semibold">
							運用する戦略
						</label>
						<select
							id={selectId}
							className="h-11 w-full rounded-lg border border-line bg-surface px-3 text-[15px] font-semibold disabled:opacity-60"
							value={active?.id ?? ""}
							disabled={busy || on || holding}
							onChange={(e) =>
								choose(e.target.value === "" ? null : Number(e.target.value))
							}
						>
							<option value="">未選択</option>
							{strategies.map((s) => (
								<option key={s.id} value={s.id}>
									{s.name}
								</option>
							))}
						</select>
						{strategies.length === 0 && (
							<p className="text-xs text-text-2">
								戦略がまだ無い。「戦略」の画面で作ると選べる
							</p>
						)}
						{on && (
							<p className="text-xs text-text-2">
								稼働中は運用する戦略を変えられない
							</p>
						)}
						{!on && holding && (
							<p className="text-xs text-text-2">
								保有か未約定の注文がある間は、運用する戦略を変えられない
							</p>
						)}
					</div>
					<Button onClick={() => setDialog("rename")}>
						タブの名前を変える
					</Button>
					{canDelete && !on && (
						<Button className="text-loss" onClick={() => setDialog("delete")}>
							タブを削除
						</Button>
					)}
					<Button onClick={() => setDialog(null)}>閉じる</Button>
				</Modal>
			)}
			{dialog === "rename" && (
				<RenameRunDialog
					run={run}
					onClose={() => setDialog(null)}
					onDone={(s) => {
						setDialog(null);
						set(s);
						onToast("タブの名前を変えた");
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
						onToast(`「${run.name}」のタブを削除した`);
					}}
				/>
			)}
			{dialog === "start" && active && (
				<Modal
					title={`「${run.name}」の自動取引を開始する（${label}）`}
					onClose={() => setDialog(null)}
				>
					<p className="leading-relaxed">
						{active.name} が、次の判定（
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
